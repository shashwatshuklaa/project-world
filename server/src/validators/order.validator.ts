import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// Extend Express Request interface to include the resolved idempotency key
declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

export const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9_\-]+$/;

/**
 * Validation schema for the idempotency key.
 * Allows alphanumeric characters, hyphens, and underscores, between 1 and 100 characters.
 */
export const idempotencyKeyRule = z
  .string()
  .trim()
  .min(1, 'Idempotency key cannot be empty')
  .max(100, 'Idempotency key cannot exceed 100 characters')
  .regex(
    IDEMPOTENCY_KEY_REGEX,
    'Invalid idempotency key format. Allowed characters are alphanumeric, hyphens, and underscores (max 100 characters).'
  );

/**
 * Validation schema for initiating an order request body.
 * Strictly disallows client injection of prices, totals, currencies, items, or user IDs.
 * The body may optionally supply the idempotencyKey, but if also supplied in the header,
 * they must match unambiguously.
 */
export const createOrderBodySchema = z
  .object({
    idempotencyKey: idempotencyKeyRule.optional(),
  })
  .strict();

export type CreateOrderBodyInput = z.infer<typeof createOrderBodySchema>;

/**
 * Express middleware to validate order creation request:
 * 1. Strictly rejects unauthorized client-injected fields in the body (price, total, items, userId, etc.).
 * 2. Resolves the mandatory idempotency key from the canonical Idempotency-Key header (or fallback body).
 * 3. Rejects requests where header and body keys conflict.
 * 4. Rejects empty, missing, or malformed idempotency keys.
 */
export function validateCreateOrder(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Validate request body with strict schema
  const bodyParsed = createOrderBodySchema.safeParse(req.body || {});
  if (!bodyParsed.success) {
    const issues = (bodyParsed.error.issues || []).map((issue: z.ZodIssue) => ({
      field: Array.isArray(issue.path) ? issue.path.join('.') : '',
      message: issue.message,
    }));
    res.status(400).json({
      success: false,
      message: 'Validation failed: Invalid or unauthorized request fields.',
      errors: issues,
    });
    return;
  }

  // 2. Extract header key (canonical) and body key
  const rawHeader =
    (req.headers['idempotency-key'] as string | undefined) ||
    (req.headers['x-idempotency-key'] as string | undefined);
  const rawBody = bodyParsed.data.idempotencyKey;

  const headerKey = typeof rawHeader === 'string' ? rawHeader.trim() : undefined;
  const bodyKey = typeof rawBody === 'string' ? rawBody.trim() : undefined;

  // 3. Ambiguity check: If both are supplied, they must match identically
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    res.status(400).json({
      success: false,
      message: 'Conflicting idempotency keys provided in header and body.',
    });
    return;
  }

  const resolvedKey = headerKey || bodyKey;

  // 4. Mandatory check: A non-empty idempotency key is strictly required
  if (!resolvedKey || resolvedKey.length === 0) {
    res.status(400).json({
      success: false,
      message: 'Idempotency key is required. Please provide a valid Idempotency-Key header.',
    });
    return;
  }

  // 5. Format validation
  const keyParsed = idempotencyKeyRule.safeParse(resolvedKey);
  if (!keyParsed.success) {
    res.status(400).json({
      success: false,
      message: keyParsed.error.issues[0]?.message || 'Invalid idempotency key format.',
    });
    return;
  }

  // Attach the canonical sanitized key for controller consumption
  req.idempotencyKey = keyParsed.data;
  if (!req.body) req.body = {};
  req.body.idempotencyKey = keyParsed.data;

  next();
}

/**
 * Strict validation schema for POST /api/orders/verify-payment.
 * Strictly disallows client injection of price, total, items, currency, or user IDs.
 */
export const verifyPaymentSchema = z
  .object({
    orderId: z
      .string()
      .trim()
      .min(1, 'Order ID cannot be empty')
      .max(40, 'Order ID cannot exceed 40 characters'),
    razorpay_order_id: z
      .string()
      .trim()
      .min(1, 'Razorpay order ID cannot be empty')
      .max(40, 'Razorpay order ID cannot exceed 40 characters'),
    razorpay_payment_id: z
      .string()
      .trim()
      .min(1, 'Razorpay payment ID cannot be empty')
      .max(40, 'Razorpay payment ID cannot exceed 40 characters'),
    razorpay_signature: z
      .string()
      .trim()
      .min(1, 'Razorpay signature cannot be empty')
      .max(128, 'Razorpay signature length is invalid'),
  })
  .strict();

export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

/**
 * Express middleware to validate payment verification requests.
 * Rejects any client-injected amounts, user IDs, or unapproved parameters.
 */
export function validateVerifyPayment(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = verifyPaymentSchema.safeParse(req.body);
  if (!result.success) {
    const issues = (result.error.issues || []).map((issue: z.ZodIssue) => ({
      field: Array.isArray(issue.path) ? issue.path.join('.') : '',
      message: issue.message,
    }));
    res.status(400).json({
      success: false,
      message: 'Validation failed: Invalid payment verification payload.',
      errors: issues,
    });
    return;
  }

  req.body = result.data;
  next();
}

/**
 * Customer-facing payment status values allowed for filtering.
 * Strictly excludes internal payment-processing or security states:
 * 'security_discrepancy', 'held_for_review', 'creating', 'unknown',
 * 'duplicate_charge_detected', 'retryable_failure'.
 */
export const CUSTOMER_FACING_PAYMENT_STATUSES = [
  'pending',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
  'refund_pending',
] as const;

export const CUSTOMER_FACING_ORDER_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'refunded',
] as const;

/**
 * Validation schema for GET /api/orders query parameters.
 * Supports page, limit, status, and paymentStatus.
 * Strictly disallows unexpected parameters (e.g. injected userId or internal states).
 */
export const getOrderHistoryQuerySchema = z
  .object({
    page: z
      .string()
      .optional()
      .default('1')
      .refine((val) => /^\d+$/.test(val) && parseInt(val, 10) > 0, {
        message: 'Page must be a positive integer greater than 0',
      })
      .transform((val) => parseInt(val, 10)),
    limit: z
      .string()
      .optional()
      .default('10')
      .refine((val) => /^\d+$/.test(val) && parseInt(val, 10) > 0 && parseInt(val, 10) <= 50, {
        message: 'Limit must be a positive integer between 1 and 50',
      })
      .transform((val) => parseInt(val, 10)),
    status: z
      .enum(CUSTOMER_FACING_ORDER_STATUSES, {
        message: 'Invalid order status filter',
      })
      .optional(),
    paymentStatus: z
      .enum(CUSTOMER_FACING_PAYMENT_STATUSES, {
        message: 'Invalid payment status filter',
      })
      .optional(),
  })
  .strict();

export type GetOrderHistoryQueryInput = z.infer<typeof getOrderHistoryQuerySchema>;

/**
 * Express middleware to validate GET /api/orders query parameters.
 */
export function validateGetOrdersQuery(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = getOrderHistoryQuerySchema.safeParse(req.query);
  if (!result.success) {
    const issues = (result.error.issues || []).map((issue: z.ZodIssue) => ({
      field: Array.isArray(issue.path) ? issue.path.join('.') : '',
      message: issue.message,
    }));
    res.status(400).json({
      success: false,
      message: 'Validation failed: Invalid query parameters.',
      errors: issues,
    });
    return;
  }

  req.query = result.data as any;
  next();
}

/**
 * Validation schema for GET /api/orders/:id URL parameters.
 * Validates that id is a valid 24-character hexadecimal MongoDB ObjectId.
 */
export const orderIdParamSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{24}$/, 'Invalid order ID format. Must be a valid 24-character hexadecimal MongoDB ObjectId.'),
  })
  .strict();

export type OrderIdParamInput = z.infer<typeof orderIdParamSchema>;

/**
 * Express middleware to validate GET /api/orders/:id URL parameter.
 */
export function validateOrderIdParam(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = orderIdParamSchema.safeParse(req.params);
  if (!result.success) {
    const issues = (result.error.issues || []).map((issue: z.ZodIssue) => ({
      field: Array.isArray(issue.path) ? issue.path.join('.') : '',
      message: issue.message,
    }));
    res.status(400).json({
      success: false,
      message: 'Invalid order ID format. Must be a valid MongoDB ObjectId.',
      errors: issues,
    });
    return;
  }

  next();
}
