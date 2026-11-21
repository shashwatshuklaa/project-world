import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
} from '../controllers/cart.controller.js';
import {
  validateBody,
  validateParams,
  addItemSchema,
  updateItemSchema,
  cartItemIdParamSchema,
} from '../validators/cart.validator.js';

const router = Router();

// Enforce authentication on all cart operations
router.use(requireAuth);

// 1. GET /api/cart - Get user's active shopping cart
router.get('/', getCart);

// 2. POST /api/cart/items - Add project to cart
router.post('/items', validateBody(addItemSchema), addItem);

// 3. PATCH /api/cart/items/:itemId - Update item quantity or customization
router.patch(
  '/items/:itemId',
  validateParams(cartItemIdParamSchema),
  validateBody(updateItemSchema),
  updateItem
);

// 4. DELETE /api/cart/items/:itemId - Remove item from cart
router.delete(
  '/items/:itemId',
  validateParams(cartItemIdParamSchema),
  removeItem
);

// 5. DELETE /api/cart - Clear all items from cart
router.delete('/', clearCart);

export default router;
