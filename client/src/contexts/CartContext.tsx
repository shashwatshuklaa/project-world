import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import {
  CartData,
  CartContextType,
  UpdateCartItemInput,
} from '../types/cart';
import { cartService, CartApiError } from '../services/cart.service';

const CartContext = createContext<CartContextType | undefined>(undefined);

export interface CartProviderProps {
  children: ReactNode;
}

/**
 * Shopping Cart Provider component.
 * Manages global cart state backed by the backend REST API and HTTP-only cookie sessions.
 * Never persists cart data or prices in client-side localStorage or sessionStorage.
 *
 * Concurrency & Race-Condition Strategy:
 * 1. Serialized Promise Queue: All cart mutations and refresh operations are queued sequentially.
 *    This eliminates write-write database races and prevents out-of-order response overwrites.
 * 2. Session Epoch Tracking: When a user logs out or switches accounts, the session epoch increments,
 *    causing any in-flight or pending tasks from the previous session to discard their results.
 * 3. Authoritative State: Every operation updates context state directly from the server response,
 *    keeping itemCount and total strictly server-authoritative.
 */
export const CartProvider: React.FC<CartProviderProps> = ({ children }) => {
  const { user, isAuthenticated, isLoading: isAuthLoading } = useAuth();

  const [cart, setCart] = useState<CartData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Serialized mutation queue to guarantee strict sequential execution
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  // Number of active or pending operations in the queue
  const inFlightCountRef = useRef<number>(0);
  // Session epoch to invalidate tasks if user logs out or switches accounts
  const sessionEpochRef = useRef<number>(0);
  // Track previous authenticated user ID to reset cart when user account changes
  const previousUserIdRef = useRef<string | null>(null);
  // Track mounted status to avoid state updates after unmount
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * Helper to enqueue an asynchronous cart task onto the serialized queue.
   * Guarantees:
   * 1. Tasks execute in exact dispatch order, never racing on the network or backend.
   * 2. If a task fails, its caller promise rejects, but subsequent tasks continue executing.
   * 3. Loading state stays true while any task is queued/running and turns false when empty.
   * 4. If authentication changes or user logs out, stale tasks from the previous session drop their results.
   */
  const enqueueCartTask = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      const taskEpoch = sessionEpochRef.current;
      inFlightCountRef.current++;

      if (isMountedRef.current && inFlightCountRef.current === 1) {
        setIsLoading(true);
      }

      return new Promise<T>((resolve, reject) => {
        queueRef.current = queueRef.current
          .then(async () => {
            // Drop task if unmounted or if authentication session changed while queued
            if (!isMountedRef.current || sessionEpochRef.current !== taskEpoch) {
              reject(new CartApiError('Operation cancelled: Session changed or component unmounted.', 401));
              return;
            }

            try {
              const result = await task();
              // Check session epoch again after asynchronous operation completes
              if (isMountedRef.current && sessionEpochRef.current === taskEpoch) {
                resolve(result);
              } else {
                reject(new CartApiError('Operation cancelled: Session changed.', 401));
              }
            } catch (err) {
              if (isMountedRef.current && sessionEpochRef.current === taskEpoch) {
                reject(err);
              } else {
                reject(new CartApiError('Operation cancelled: Session changed.', 401));
              }
            }
          })
          .catch((unexpectedErr) => {
            // Guard against unhandled queue rejections to preserve chain continuity
            console.error('[CartContext] Unexpected queue error:', unexpectedErr);
          })
          .finally(() => {
            if (taskEpoch === sessionEpochRef.current) {
              inFlightCountRef.current = Math.max(0, inFlightCountRef.current - 1);
              if (isMountedRef.current && inFlightCountRef.current === 0) {
                setIsLoading(false);
              }
            }
          });
      });
    },
    []
  );

  /**
   * Fetch current cart from the backend API.
   * Enqueued through the serializer to avoid racing with in-flight mutations.
   */
  const refreshCart = useCallback(async (): Promise<void> => {
    if (!isAuthenticated) {
      setCart(null);
      setError(null);
      return;
    }

    return enqueueCartTask(async () => {
      try {
        const response = await cartService.getCart();
        setCart(response.data.cart);
        setError(null);
      } catch (err) {
        const message =
          err instanceof CartApiError
            ? err.message
            : 'Failed to load shopping cart from server.';
        setError(message);
        throw err;
      }
    });
  }, [isAuthenticated, enqueueCartTask]);

  /**
   * Synchronize cart with authentication lifecycle:
   * - While authentication is initializing, wait without clearing or querying.
   * - When authenticated, load user's cart from MongoDB.
   * - When logged out or unauthenticated, clear cart immediately and invalidate pending tasks.
   * - When switching user accounts, invalidate previous user's cart.
   */
  useEffect(() => {
    // 1. Wait until authentication check completes
    if (isAuthLoading) {
      return;
    }

    const currentUserId = user?.id || null;

    // 2. If unauthenticated, immediately clear cart state and invalidate pending tasks
    if (!isAuthenticated || !currentUserId) {
      sessionEpochRef.current++; // Invalidate any queued/running tasks
      previousUserIdRef.current = null;
      inFlightCountRef.current = 0;
      setCart(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    // 3. If user changed (e.g. logged into a different account), reset previous cart & increment epoch
    if (previousUserIdRef.current && previousUserIdRef.current !== currentUserId) {
      sessionEpochRef.current++;
      setCart(null);
    }
    previousUserIdRef.current = currentUserId;

    // 4. Fetch the authenticated user's cart
    refreshCart().catch((err) => {
      // Background session load errors logged safely without unhandled rejections
      console.warn('[CartContext] Background cart refresh failed:', err);
    });
  }, [isAuthLoading, isAuthenticated, user?.id, refreshCart]);

  /**
   * Add a project to the cart.
   * Serialized to ensure deterministic server-side updates and zero race conditions.
   */
  const addToCart = useCallback(
    async (projectId: string, quantity = 1, customization?: string): Promise<void> => {
      if (!isAuthenticated) {
        throw new CartApiError('Please log in to add items to your cart.', 401);
      }

      return enqueueCartTask(async () => {
        try {
          const response = await cartService.addToCart({
            projectId,
            quantity,
            customization,
          });
          setCart(response.data.cart);
          setError(null);
        } catch (err) {
          const message =
            err instanceof CartApiError
              ? err.message
              : 'Failed to add item to cart.';
          setError(message);
          throw err;
        }
      });
    },
    [isAuthenticated, enqueueCartTask]
  );

  /**
   * Update quantity or customization for a specific cart item.
   */
  const updateItem = useCallback(
    async (itemId: string, data: UpdateCartItemInput): Promise<void> => {
      if (!isAuthenticated) {
        throw new CartApiError('Please log in to update your cart.', 401);
      }

      return enqueueCartTask(async () => {
        try {
          const response = await cartService.updateCartItem(itemId, data);
          setCart(response.data.cart);
          setError(null);
        } catch (err) {
          const message =
            err instanceof CartApiError
              ? err.message
              : 'Failed to update cart item.';
          setError(message);
          throw err;
        }
      });
    },
    [isAuthenticated, enqueueCartTask]
  );

  /**
   * Remove a specific item from the cart.
   */
  const removeItem = useCallback(
    async (itemId: string): Promise<void> => {
      if (!isAuthenticated) {
        throw new CartApiError('Please log in to modify your cart.', 401);
      }

      return enqueueCartTask(async () => {
        try {
          const response = await cartService.removeCartItem(itemId);
          setCart(response.data.cart);
          setError(null);
        } catch (err) {
          const message =
            err instanceof CartApiError
              ? err.message
              : 'Failed to remove item from cart.';
          setError(message);
          throw err;
        }
      });
    },
    [isAuthenticated, enqueueCartTask]
  );

  /**
   * Clear all items from the cart.
   */
  const clearCart = useCallback(async (): Promise<void> => {
    if (!isAuthenticated) {
      setCart(null);
      return;
    }

    return enqueueCartTask(async () => {
      try {
        const response = await cartService.clearCart();
        setCart(response.data.cart);
        setError(null);
      } catch (err) {
        const message =
          err instanceof CartApiError
            ? err.message
            : 'Failed to clear shopping cart.';
        setError(message);
        throw err;
      }
    });
  }, [isAuthenticated, enqueueCartTask]);

  // Server-authoritative derived counts and totals
  const cartCount = cart?.itemCount ?? 0;
  const cartTotal = cart?.total ?? 0;

  return (
    <CartContext.Provider
      value={{
        cart,
        cartCount,
        cartTotal,
        isLoading,
        error,
        refreshCart,
        addToCart,
        updateItem,
        removeItem,
        clearCart,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = (): CartContextType => {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};

export default CartContext;
