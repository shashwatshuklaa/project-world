import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Cart, ICart } from '../models/Cart.js';
import { Project, IProject } from '../models/Project.js';
import { AddItemInput, UpdateItemInput, CartItemIdParamInput } from '../validators/cart.validator.js';

export interface FormattedCartItem {
  id: string;
  _id: string;
  project: {
    id: string;
    slug?: string;
    _id: string;
    title: string;
    category: string;
    subcategory: string;
    price: number;
    image: string;
    difficulty?: string;
  };
  quantity: number;
  customization: string;
  unitPrice: number;
  itemTotal: number;
}

export interface FormattedCart {
  items: FormattedCartItem[];
  subtotal: number;
  total: number;
  itemCount: number;
}

export const MAX_CONCURRENCY_RETRIES = 3;

/**
 * Checks whether an error represents an optimistic concurrency conflict (VersionError)
 * or a duplicate key error (code 11000) specifically involving the Cart model's unique user index.
 * Does not classify unrelated duplicate key errors or errors with ambiguous/missing index info as concurrency conflicts.
 */
export function isConcurrencyConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, any>;

  // 1. Mongoose optimistic concurrency VersionError
  if (err instanceof mongoose.Error.VersionError || err.name === 'VersionError') {
    return true;
  }

  // 2. Check if this is a MongoDB duplicate-key error (code 11000 / E11000)
  const isDuplicateKey =
    err.code === 11000 ||
    (typeof err.message === 'string' && err.message.includes('E11000'));

  if (!isDuplicateKey) {
    return false;
  }

  // 3. Must specifically involve the Cart unique 'user' index
  if (err.keyPattern && typeof err.keyPattern === 'object' && 'user' in err.keyPattern) {
    return true;
  }

  if (err.keyValue && typeof err.keyValue === 'object' && 'user' in err.keyValue) {
    return true;
  }

  if (typeof err.message === 'string') {
    // Matches explicit index naming (e.g. index: user_1 or index: test.carts.user_1) or dup key payload ({ user: ...)
    if (
      /\bindex:\s*(?:[\w.]+\.)?user_\d+\b/.test(err.message) ||
      /\bdup key:\s*\{\s*user\b/.test(err.message) ||
      err.message.includes('index: user_1')
    ) {
      return true;
    }
  }

  // 4. If index/key information is missing, ambiguous, or unrelated (e.g. email_1), do not assume concurrency conflict
  return false;
}

/**
 * Atomically finds or creates a cart for the specified user.
 * Guarantees that concurrent requests for a first-time cart do not crash
 * with an E11000 duplicate key error and safely returns the created or existing document.
 */
export async function getOrCreateCart(userId: string | mongoose.Types.ObjectId): Promise<ICart> {
  // 1. Try finding existing cart first
  let cart = await Cart.findOne({ user: userId });
  if (cart) {
    return cart;
  }

  // 2. Attempt atomic upsert to avoid duplicate key errors
  try {
    cart = await Cart.findOneAndUpdate(
      { user: userId },
      { $setOnInsert: { user: userId, items: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (cart) {
      return cart;
    }
  } catch (error: any) {
    // If a duplicate key race condition occurred during upsert, fetch the cart created by competing request
    if (isConcurrencyConflict(error)) {
      cart = await Cart.findOne({ user: userId });
      if (cart) {
        return cart;
      }
    }
    throw error;
  }

  // 3. Fallback to fresh fetch or creation if findOneAndUpdate returned empty
  cart = await Cart.findOne({ user: userId });
  if (!cart) {
    cart = new Cart({ user: userId, items: [] });
  }
  return cart;
}

/**
 * Helper to compute cart totals using current canonical Project prices from MongoDB.
 * Gracefully handles deleted/missing project documents without crashing.
 */
export async function populateAndCalculateCart(cart: ICart | null): Promise<FormattedCart> {
  if (!cart || !cart.items || cart.items.length === 0) {
    return {
      items: [],
      subtotal: 0,
      total: 0,
      itemCount: 0,
    };
  }

  // Retrieve all referenced project documents in one batch
  const projectIds = cart.items
    .map((item) => (item.project ? item.project.toString() : null))
    .filter(Boolean);

  const projects = await Project.find({ _id: { $in: projectIds } }).lean();
  const projectMap = new Map<string, Partial<IProject> & { _id: mongoose.Types.ObjectId }>();
  for (const p of projects) {
    projectMap.set(p._id.toString(), p);
  }

  const validItems: FormattedCartItem[] = [];
  let subtotal = 0;
  let itemCount = 0;
  let hasOrphans = false;

  for (const item of cart.items) {
    const projIdStr = item.project?.toString();
    const projectDoc = projIdStr ? projectMap.get(projIdStr) : null;

    if (!projectDoc) {
      // Orphaned item - project was deleted or unpublished from database
      hasOrphans = true;
      continue;
    }

    const unitPrice = typeof projectDoc.price === 'number' ? projectDoc.price : 0;
    const itemTotal = Math.round(unitPrice * item.quantity * 100) / 100;
    subtotal += itemTotal;
    itemCount += item.quantity;

    const itemIdStr = item._id ? item._id.toString() : '';

    validItems.push({
      id: itemIdStr,
      _id: itemIdStr,
      project: {
        id: projectDoc.slug || projectDoc._id.toString(),
        slug: projectDoc.slug,
        _id: projectDoc._id.toString(),
        title: projectDoc.title || 'Untitled Project',
        category: projectDoc.category || '',
        subcategory: projectDoc.subcategory || '',
        price: unitPrice,
        image: projectDoc.image || '',
        difficulty: projectDoc.difficulty,
      },
      quantity: item.quantity,
      customization: item.customization || '',
      unitPrice,
      itemTotal,
    });
  }

  // Prune orphans if any were found and save is supported
  if (hasOrphans && typeof (cart as any).save === 'function') {
    cart.items = cart.items.filter((item) => projectMap.has(item.project?.toString())) as any;
    try {
      await cart.save();
    } catch (saveErr) {
      console.warn('[Cart Controller] Failed to prune orphaned items from cart:', saveErr);
    }
  }

  const calculatedSubtotal = Math.round(subtotal * 100) / 100;

  return {
    items: validItems,
    subtotal: calculatedSubtotal,
    total: calculatedSubtotal,
    itemCount,
  };
}

/**
 * GET /api/cart
 * Returns the authenticated user's current shopping cart with server-calculated totals.
 */
export async function getCart(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const cart = await Cart.findOne({ user: userId });
    const formattedCart = await populateAndCalculateCart(cart);

    res.status(200).json({
      success: true,
      data: {
        cart: formattedCart,
      },
    });
  } catch (error) {
    console.error('[Cart Controller] Error in getCart:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve shopping cart. Please try again later.',
    });
  }
}

/**
 * POST /api/cart/items
 * Adds a project to the cart or increments quantity if already present.
 * Uses bounded optimistic concurrency retries (max 3 attempts) to safely resolve race conditions.
 */
export async function addItem(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { projectId, quantity = 1, customization = '' } = req.body as AddItemInput;

    // 1. Look up canonical project in MongoDB once before any retry loop
    const projectQuery = mongoose.Types.ObjectId.isValid(projectId)
      ? { $or: [{ slug: projectId }, { _id: projectId }] }
      : { slug: projectId };

    const project = await Project.findOne(projectQuery);

    if (!project) {
      res.status(404).json({
        success: false,
        message: `Project not found with identifier: ${projectId}`,
      });
      return;
    }

    const projectObjIdStr = project._id.toString();

    // 2. Retry loop for concurrency conflicts (max 3 attempts total)
    let attempts = 0;
    while (attempts < MAX_CONCURRENCY_RETRIES) {
      attempts++;
      try {
        const cart = await getOrCreateCart(userId);

        // Check if project is already present in cart
        const existingItem = cart.items.find(
          (item: any) => item.project && item.project.toString() === projectObjIdStr
        );

        if (existingItem) {
          if (existingItem.quantity >= 10) {
            res.status(400).json({
              success: false,
              message: 'Cannot add more. Item is already at the maximum quantity limit of 10.',
            });
            return;
          }

          if (existingItem.quantity + quantity > 10) {
            res.status(400).json({
              success: false,
              message: `Cannot add ${quantity} item(s). Exceeds the maximum quantity limit of 10 per project (current quantity: ${existingItem.quantity}).`,
            });
            return;
          }

          existingItem.quantity += quantity;
          if (customization) {
            existingItem.customization = customization;
          }
        } else {
          cart.items.push({
            project: project._id,
            quantity,
            customization,
          } as any);
        }

        await cart.save();
        const formattedCart = await populateAndCalculateCart(cart);

        res.status(200).json({
          success: true,
          message: 'Item added to cart successfully',
          data: {
            cart: formattedCart,
          },
        });
        return;
      } catch (err: any) {
        if (isConcurrencyConflict(err) && attempts < MAX_CONCURRENCY_RETRIES) {
          console.warn(`[Cart Controller] addItem conflict on attempt ${attempts}. Retrying with fresh cart...`);
          continue;
        }

        if (isConcurrencyConflict(err)) {
          res.status(409).json({
            success: false,
            message: 'Cart was modified concurrently by another session. Please try again.',
          });
          return;
        }

        // Other non-concurrency database errors
        throw err;
      }
    }
  } catch (error) {
    console.error('[Cart Controller] Error in addItem:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add item to cart. Please try again later.',
    });
  }
}

/**
 * PATCH /api/cart/items/:itemId
 * Updates quantity or customization for a specific cart subdocument.
 * Uses bounded optimistic concurrency retries (max 3 attempts).
 */
export async function updateItem(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { itemId } = req.params as CartItemIdParamInput;
    const { quantity, customization } = req.body as UpdateItemInput;

    let attempts = 0;
    while (attempts < MAX_CONCURRENCY_RETRIES) {
      attempts++;
      try {
        const cart = await Cart.findOne({ user: userId });
        if (!cart) {
          res.status(404).json({
            success: false,
            message: 'Cart not found',
          });
          return;
        }

        const item = cart.items.find((i: any) => i._id?.toString() === itemId);
        if (!item) {
          res.status(404).json({
            success: false,
            message: 'Item not found in cart',
          });
          return;
        }

        if (quantity !== undefined) {
          item.quantity = quantity;
        }

        if (customization !== undefined) {
          item.customization = customization;
        }

        await cart.save();
        const formattedCart = await populateAndCalculateCart(cart);

        res.status(200).json({
          success: true,
          message: 'Cart item updated successfully',
          data: {
            cart: formattedCart,
          },
        });
        return;
      } catch (err: any) {
        if (isConcurrencyConflict(err) && attempts < MAX_CONCURRENCY_RETRIES) {
          console.warn(`[Cart Controller] updateItem conflict on attempt ${attempts}. Retrying with fresh cart...`);
          continue;
        }

        if (isConcurrencyConflict(err)) {
          res.status(409).json({
            success: false,
            message: 'Cart was modified concurrently by another session. Please try again.',
          });
          return;
        }

        throw err;
      }
    }
  } catch (error) {
    console.error('[Cart Controller] Error in updateItem:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update cart item. Please try again later.',
    });
  }
}

/**
 * DELETE /api/cart/items/:itemId
 * Removes an individual item from the authenticated user's cart.
 * Uses bounded optimistic concurrency retries (max 3 attempts).
 */
export async function removeItem(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { itemId } = req.params as CartItemIdParamInput;

    let attempts = 0;
    while (attempts < MAX_CONCURRENCY_RETRIES) {
      attempts++;
      try {
        const cart = await Cart.findOne({ user: userId });
        if (!cart) {
          res.status(404).json({
            success: false,
            message: 'Cart not found',
          });
          return;
        }

        const itemIndex = cart.items.findIndex((i: any) => i._id?.toString() === itemId);
        if (itemIndex === -1) {
          res.status(404).json({
            success: false,
            message: 'Item not found in cart',
          });
          return;
        }

        cart.items.splice(itemIndex, 1);
        await cart.save();

        const formattedCart = await populateAndCalculateCart(cart);

        res.status(200).json({
          success: true,
          message: 'Item removed from cart successfully',
          data: {
            cart: formattedCart,
          },
        });
        return;
      } catch (err: any) {
        if (isConcurrencyConflict(err) && attempts < MAX_CONCURRENCY_RETRIES) {
          console.warn(`[Cart Controller] removeItem conflict on attempt ${attempts}. Retrying with fresh cart...`);
          continue;
        }

        if (isConcurrencyConflict(err)) {
          res.status(409).json({
            success: false,
            message: 'Cart was modified concurrently by another session. Please try again.',
          });
          return;
        }

        throw err;
      }
    }
  } catch (error) {
    console.error('[Cart Controller] Error in removeItem:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove item from cart. Please try again later.',
    });
  }
}

/**
 * DELETE /api/cart
 * Clears all items from the authenticated user's cart.
 * Uses bounded optimistic concurrency retries (max 3 attempts).
 */
export async function clearCart(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    let attempts = 0;
    while (attempts < MAX_CONCURRENCY_RETRIES) {
      attempts++;
      try {
        const cart = await Cart.findOne({ user: userId });
        if (cart) {
          cart.items = [] as any;
          await cart.save();
        }

        res.status(200).json({
          success: true,
          message: 'Cart cleared successfully',
          data: {
            cart: {
              items: [],
              subtotal: 0,
              total: 0,
              itemCount: 0,
            },
          },
        });
        return;
      } catch (err: any) {
        if (isConcurrencyConflict(err) && attempts < MAX_CONCURRENCY_RETRIES) {
          console.warn(`[Cart Controller] clearCart conflict on attempt ${attempts}. Retrying with fresh cart...`);
          continue;
        }

        if (isConcurrencyConflict(err)) {
          res.status(409).json({
            success: false,
            message: 'Cart was modified concurrently by another session. Please try again.',
          });
          return;
        }

        throw err;
      }
    }
  } catch (error) {
    console.error('[Cart Controller] Error in clearCart:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear cart. Please try again later.',
    });
  }
}
