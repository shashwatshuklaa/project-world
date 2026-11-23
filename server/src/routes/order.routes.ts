import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  createOrder,
  verifyPayment,
  getOrders,
  getOrderById,
} from '../controllers/order.controller.js';
import {
  validateCreateOrder,
  validateVerifyPayment,
  validateGetOrdersQuery,
  validateOrderIdParam,
} from '../validators/order.validator.js';

const router = Router();

// Enforce strict authentication on all order operations
router.use(requireAuth);

/**
 * GET /api/orders
 * Returns paginated order history for the authenticated user.
 * Supports query parameters: page, limit, status, paymentStatus.
 */
router.get('/', validateGetOrdersQuery, getOrders);

/**
 * GET /api/orders/:id
 * Returns complete order details for a specific order owned by the authenticated user.
 * Requires a valid 24-character hexadecimal MongoDB ObjectId.
 */
router.get('/:id', validateOrderIdParam, getOrderById);

/**
 * POST /api/orders
 * Initiates an order using the authenticated user's server-authoritative MongoDB cart.
 * Requires a valid, user-scoped Idempotency-Key.
 * Rejects client-supplied prices, amounts, cart items, or user IDs.
 */
router.post('/', validateCreateOrder, createOrder);

/**
 * POST /api/orders/verify-payment
 * Verifies Razorpay payment signature and transitions order to paid/completed.
 * Reconciles the purchased items from the user's cart without wiping out newly added items.
 */
router.post('/verify-payment', validateVerifyPayment, verifyPayment);

export default router;
