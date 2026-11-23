import { Request, Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { Order, IOrderItem } from '../models/Order.js';
import { Cart, ICartItem } from '../models/Cart.js';
import { Project, IProject } from '../models/Project.js';
import { getRazorpayClient, getRazorpayKeyId } from '../config/razorpay.js';
import {
  verifyPaymentSignature,
  processSuccessfulPayment,
  processPaymentCapture,
  PaymentNotCapturedError,
  GatewayOrderMismatchError,
  GatewayAmountMismatchError,
  GatewayCurrencyMismatchError,
  SecurityDiscrepancyError,
  OrderNotFoundError,
  MissingCanonicalAmountError,
} from '../services/payment.service.js';

/**
 * Duration in milliseconds after which an uncompleted reservation ('creating')
 * is considered stale/abandoned (e.g. process crash or hung network call).
 */
export const RESERVATION_LEASE_MS = 15_000;

export type RazorpayOutcomeType = 'definite_rejection' | 'uncertain';

/**
 * Generates an internal orderId and a persistent deterministic Razorpay receipt.
 * Both are strictly within Razorpay's 40-character maximum length constraint.
 */
export function generateOrderIdentifiers(): { orderId: string; receipt: string } {
  const hex = crypto.randomBytes(16).toString('hex'); // 32 characters
  return {
    orderId: `ord_${hex}`, // 36 characters (<= 40)
    receipt: `rcpt_${hex}`, // 37 characters (<= 40)
  };
}

/**
 * Checks whether an error represents a Razorpay duplicate-receipt constraint violation.
 * Handles HTTP 409 Conflict as well as HTTP 400 with duplicate-receipt messages.
 */
export function isDuplicateReceiptError(error: any): boolean {
  if (!error) return false;
  const rawStatus = error.statusCode || error.status || error.response?.status;
  const statusCode = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);

  const errorCode = (
    typeof error.code === 'string'
      ? error.code
      : typeof error.error?.code === 'string'
        ? error.error.code
        : ''
  ).toLowerCase();

  const text = [
    typeof error.message === 'string' ? error.message : '',
    typeof error.error?.description === 'string' ? error.error.description : '',
    typeof error.description === 'string' ? error.description : '',
    typeof error.error?.field === 'string' ? error.error.field : '',
  ]
    .join(' ')
    .toLowerCase();

  // Explicit HTTP 409 Conflict
  if (statusCode === 409) {
    return true;
  }

  // Check error message/description and error code for duplicate receipt violations
  const mentionsReceipt = text.includes('receipt') || errorCode.includes('receipt');
  const mentionsDuplicate =
    text.includes('exist') ||
    text.includes('unique') ||
    text.includes('duplicate') ||
    text.includes('already') ||
    errorCode.includes('duplicate') ||
    errorCode.includes('already_exists') ||
    errorCode.includes('conflict');

  return mentionsReceipt && mentionsDuplicate;
}

/**
 * Classifies an error from the Razorpay API into a definite rejection
 * (safe to release reservation for retry) or an uncertain outcome
 * (network timeout, connection drop, 5xx, 408, 429, or duplicate receipt where order may exist).
 *
 * Golden rule: ONLY classify an error as a definite rejection when available
 * evidence proves that NO Razorpay order was created.
 * Any ambiguity defaults to 'uncertain'.
 */
export function classifyRazorpayError(error: any): RazorpayOutcomeType {
  if (!error) return 'uncertain';

  // 1. Duplicate receipt constraint violation is NEVER a definite rejection.
  // An order with this receipt exists or is in flight on Razorpay; reconciliation is required.
  if (isDuplicateReceiptError(error)) {
    return 'uncertain';
  }

  const rawStatus = error.statusCode || error.status || error.response?.status;
  const statusCode = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);

  const errorCode = (
    typeof error.code === 'string'
      ? error.code
      : typeof error.error?.code === 'string'
        ? error.error.code
        : ''
  ).toUpperCase();

  const text = [
    typeof error.message === 'string' ? error.message : '',
    typeof error.error?.description === 'string' ? error.error.description : '',
    typeof error.description === 'string' ? error.description : '',
  ]
    .join(' ')
    .toLowerCase();

  // 2. Network / socket / timeout indicators -> uncertain outcome
  const uncertainNetworkCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ESOCKETTIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET_TIMEOUT',
    'ERR_BAD_RESPONSE',
    'ERR_NETWORK',
    'ECONNABORTED',
  ];
  if (errorCode && uncertainNetworkCodes.includes(errorCode)) {
    return 'uncertain';
  }

  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('connection reset') ||
    text.includes('socket hang up') ||
    text.includes('network error') ||
    text.includes('interrupted') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('econnrefused')
  ) {
    return 'uncertain';
  }

  // 3. HTTP 408 Request Timeout -> uncertain
  // The gateway or intermediate proxy timed out; the order may have been created.
  if (statusCode === 408) {
    return 'uncertain';
  }

  // 4. HTTP 429 Rate Limiting -> uncertain
  // Rate-limiting could occur concurrently with or after request processing.
  // Releasing the reservation would permit flood retries and risk duplicate orders.
  if (statusCode === 429) {
    return 'uncertain';
  }

  // 5. HTTP 5xx Gateway / Server Errors (500, 502, 503, 504, etc.) -> uncertain
  // The gateway failed while handling the request; the order may have been persisted before failure.
  if (!isNaN(statusCode) && statusCode >= 500 && statusCode < 600) {
    return 'uncertain';
  }

  // 6. Definite rejections: Only classify as definite rejection when available evidence
  // establishes that no Razorpay order was created:
  // - HTTP 400 Bad Request (parameter validation error, e.g. invalid amount/currency/notes)
  // - HTTP 401 Unauthorized / HTTP 403 Forbidden (API credential / permission failure)
  // - HTTP 404 Not Found (endpoint does not exist)
  // - HTTP 422 Unprocessable Entity (semantic payload validation failure)
  if (
    statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 422
  ) {
    return 'definite_rejection';
  }

  // Razorpay error object with BAD_REQUEST_ERROR or GATEWAY_AUTHENTICATION_ERROR without 408/409/429/5xx
  if (
    errorCode === 'BAD_REQUEST_ERROR' ||
    errorCode === 'GATEWAY_AUTHENTICATION_ERROR' ||
    errorCode === 'AUTHENTICATION_ERROR'
  ) {
    return 'definite_rejection';
  }

  // 7. Conservative fallback: treat any other unverified or ambiguous status as uncertain
  return 'uncertain';
}

/**
 * Validates a reconciliation result before associating it with an internal order:
 * Guarantees exact receipt, expected amount in paise, and expected currency match.
 * Prevents associating an unrelated or mismatched gateway order.
 */
export function isValidReconciliationMatch(
  matchedOrder: { receipt?: string; amount: string | number; currency: string } | null,
  expected: { receipt: string; amountInPaise: number; currency: string }
): boolean {
  if (!matchedOrder || !matchedOrder.receipt) return false;
  if (matchedOrder.receipt !== expected.receipt) return false;
  if (Number(matchedOrder.amount) !== expected.amountInPaise) return false;
  if (matchedOrder.currency.toUpperCase() !== expected.currency.toUpperCase()) return false;
  return true;
}

/**
 * Queries Razorpay for an existing order with the exact persistent receipt
 * using the verified official SDK method: razorpay.orders.all({ receipt }).
 */
export async function reconcileRazorpayOrder(
  receipt: string
): Promise<{ id: string; currency: string; amount: string | number; receipt: string } | null> {
  const razorpay = getRazorpayClient();
  const response = await razorpay.orders.all({ receipt });

  if (response && Array.isArray(response.items) && response.items.length > 0) {
    const matched = response.items[0];
    return {
      id: matched.id,
      currency: matched.currency,
      amount: matched.amount,
      receipt: matched.receipt || receipt,
    };
  }

  return null;
}

/**
 * Helper to poll for in-progress order completion across concurrent requests or processes.
 */
async function pollForOrderResolution(
  userId: mongoose.Types.ObjectId,
  idempotencyKey: string,
  res: Response,
  maxWaitMs = 1500,
  intervalMs = 150
): Promise<void> {
  let elapsed = 0;
  let resolvedOrder: any = null;

  while (elapsed < maxWaitMs) {
    resolvedOrder = await Order.findOne({ userId, idempotencyKey });
    if (resolvedOrder && resolvedOrder.paymentStatus === 'created' && resolvedOrder.razorpayOrderId) {
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    elapsed += intervalMs;
  }

  if (resolvedOrder && resolvedOrder.paymentStatus === 'created' && resolvedOrder.razorpayOrderId) {
    const keyId = getRazorpayKeyId();
    res.status(200).json({
      success: true,
      orderId: resolvedOrder.orderId,
      razorpayOrderId: resolvedOrder.razorpayOrderId,
      amount: Math.round(resolvedOrder.totalAmount * 100),
      currency: resolvedOrder.currency,
      keyId,
    });
    return;
  }

  res.status(409).json({
    success: false,
    message: 'Checkout is currently being processed for this request. Please retry in a moment.',
    inProgress: true,
  });
}

/**
 * Initiates an order and creates a corresponding Razorpay order.
 *
 * Concurrency, Deterministic Receipt & Recovery Guarantees:
 * 1. Generates and persists a deterministic receipt (<= 40 chars) on the Order reservation before contacting Razorpay.
 * 2. Uses the exact same persistent stored receipt for all gateway create and reconciliation calls; never generates a new receipt on retry.
 * 3. Atomic MongoDB Reservation: Saves in 'creating' state before calling Razorpay, blocking concurrent threads.
 * 4. Stale Reservation Recovery: Reconciles via stored receipt; does not delete reservations simply because an order is not yet visible in list queries.
 * 5. Duplicate Receipt Defense: If Razorpay rejects due to duplicate receipt, reconciles using the existing receipt.
 * 6. Reconciliation Verification: Strict validation of receipt, amount, and currency before attachment.
 * 7. Multi-Process Recovery: Uses atomic findOneAndUpdate state claiming to coordinate recovery across processes.
 * 8. Cart Consistency: The user's MongoDB cart is kept intact and never cleared during order creation.
 */
export async function createOrder(req: Request, res: Response): Promise<void> {
  let reservedOrderDoc: any = null;

  try {
    // 1. Verify user authentication
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in to complete your purchase.',
      });
      return;
    }

    const userIdStr = req.user.id;
    let userIdObj: mongoose.Types.ObjectId;
    try {
      userIdObj = new mongoose.Types.ObjectId(userIdStr);
    } catch {
      res.status(400).json({
        success: false,
        message: 'Invalid user identification token.',
      });
      return;
    }

    // 2. Extract sanitized idempotency key (guaranteed non-empty by validator)
    const idempotencyKey = req.idempotencyKey || req.body?.idempotencyKey;
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      res.status(400).json({
        success: false,
        message: 'Idempotency key is required. Please provide a valid Idempotency-Key header.',
      });
      return;
    }

    // 3. Fast-path check: Existing order for this user & idempotency key
    const existingOrder = await Order.findOne({
      userId: userIdObj,
      idempotencyKey,
    });

    if (existingOrder) {
      const expectedAmountInPaise = Math.round(existingOrder.totalAmount * 100);

      // 3A. Completed & Associated
      if (existingOrder.paymentStatus === 'created' && existingOrder.razorpayOrderId) {
        const keyId = getRazorpayKeyId();
        res.status(200).json({
          success: true,
          id: existingOrder._id.toString(),
          _id: existingOrder._id.toString(),
          orderId: existingOrder.orderId,
          razorpayOrderId: existingOrder.razorpayOrderId,
          amount: expectedAmountInPaise,
          currency: existingOrder.currency,
          keyId,
        });
        return;
      }

      // 3B. In-flight active reservation ('creating' and age < RESERVATION_LEASE_MS)
      const reservationAgeMs = Date.now() - new Date(existingOrder.createdAt).getTime();
      if (existingOrder.paymentStatus === 'creating' && reservationAgeMs < RESERVATION_LEASE_MS) {
        await pollForOrderResolution(userIdObj, idempotencyKey, res);
        return;
      }

      // 3C. Stale Reservation or Uncertain State ('creating' stale or 'unknown'):
      // Atomically claim recovery ownership in MongoDB across server processes
      if (
        (existingOrder.paymentStatus === 'creating' && reservationAgeMs >= RESERVATION_LEASE_MS) ||
        existingOrder.paymentStatus === 'unknown'
      ) {
        const claimed = await Order.findOneAndUpdate(
          {
            _id: existingOrder._id,
            paymentStatus: { $in: ['creating', 'unknown'] },
            updatedAt: existingOrder.updatedAt,
          },
          {
            $set: { updatedAt: new Date() },
          },
          { new: true }
        );

        if (!claimed) {
          // Another concurrent process claimed recovery; poll for resolution
          await pollForOrderResolution(userIdObj, idempotencyKey, res);
          return;
        }

        // Attempt reconciliation using the persistent, stored receipt
        const persistentReceipt = existingOrder.receipt;
        let matched: any = null;

        try {
          matched = await reconcileRazorpayOrder(persistentReceipt);
        } catch (reconErr) {
          existingOrder.paymentStatus = 'unknown';
          existingOrder.failureReason = 'Gateway unreachable during recovery reconciliation.';
          await existingOrder.save();

          res.status(503).json({
            success: false,
            message: 'Payment gateway could not be reached to verify order status. Please retry shortly.',
            resolutionNeeded: true,
          });
          return;
        }

        // If an order with this receipt is found on Razorpay: validate and attach
        if (matched) {
          const isValid = isValidReconciliationMatch(matched, {
            receipt: persistentReceipt,
            amountInPaise: expectedAmountInPaise,
            currency: existingOrder.currency,
          });

          if (!isValid) {
            existingOrder.paymentStatus = 'unknown';
            existingOrder.failureReason = 'Reconciliation validation failed: Mismatched gateway receipt, amount, or currency.';
            await existingOrder.save();

            res.status(500).json({
              success: false,
              message: 'Payment gateway returned a mismatched order association. Order is held for resolution.',
              resolutionNeeded: true,
            });
            return;
          }

          existingOrder.razorpayOrderId = matched.id;
          existingOrder.paymentStatus = 'created';
          await existingOrder.save();

          const keyId = getRazorpayKeyId();
          res.status(200).json({
            success: true,
            id: existingOrder._id.toString(),
            _id: existingOrder._id.toString(),
            orderId: existingOrder.orderId,
            razorpayOrderId: existingOrder.razorpayOrderId,
            amount: expectedAmountInPaise,
            currency: existingOrder.currency,
            keyId,
          });
          return;
        }

        // If matched is null, the order is not immediately visible in list query.
        // DO NOT DELETE the reservation. Call razorpay.orders.create with the EXACT SAME RECEIPT.
        try {
          const razorpay = getRazorpayClient();
          const rzpOrder = await razorpay.orders.create({
            amount: expectedAmountInPaise,
            currency: existingOrder.currency,
            receipt: persistentReceipt,
            notes: {
              orderId: existingOrder.orderId,
              receipt: persistentReceipt,
              userId: userIdStr,
            },
          });

          existingOrder.razorpayOrderId = rzpOrder.id;
          existingOrder.paymentStatus = 'created';
          await existingOrder.save();

          const keyId = getRazorpayKeyId();
          res.status(200).json({
            success: true,
            id: existingOrder._id.toString(),
            _id: existingOrder._id.toString(),
            orderId: existingOrder.orderId,
            razorpayOrderId: existingOrder.razorpayOrderId,
            amount: expectedAmountInPaise,
            currency: existingOrder.currency,
            keyId,
          });
          return;
        } catch (createErr: any) {
          // If rejected because receipt already exists on Razorpay, reconcile again
          if (isDuplicateReceiptError(createErr)) {
            const recheck = await reconcileRazorpayOrder(persistentReceipt);
            if (recheck) {
              const isValid = isValidReconciliationMatch(recheck, {
                receipt: persistentReceipt,
                amountInPaise: expectedAmountInPaise,
                currency: existingOrder.currency,
              });
              if (isValid) {
                existingOrder.razorpayOrderId = recheck.id;
                existingOrder.paymentStatus = 'created';
                await existingOrder.save();

                const keyId = getRazorpayKeyId();
                res.status(200).json({
                  success: true,
                  orderId: existingOrder.orderId,
                  razorpayOrderId: existingOrder.razorpayOrderId,
                  amount: expectedAmountInPaise,
                  currency: existingOrder.currency,
                  keyId,
                });
                return;
              } else {
                existingOrder.paymentStatus = 'unknown';
                existingOrder.failureReason =
                  'Reconciliation validation failed: Mismatched gateway receipt, amount, or currency on duplicate receipt.';
                await existingOrder.save();

                res.status(500).json({
                  success: false,
                  message: 'Payment gateway returned a mismatched order association. Order is held for resolution.',
                  resolutionNeeded: true,
                });
                return;
              }
            }
          }

          const outcome = classifyRazorpayError(createErr);
          if (outcome === 'definite_rejection') {
            existingOrder.paymentStatus = 'retryable_failure';
            existingOrder.failureReason = createErr.message || 'Payment gateway rejected request';
            await existingOrder.save();

            const clientStatus =
              createErr.statusCode === 401 || createErr.statusCode === 403 ? 502 : 400;
            res.status(clientStatus).json({
              success: false,
              message:
                clientStatus === 502
                  ? 'Payment gateway authorization failed. Please contact support.'
                  : 'Payment gateway rejected the order request. Please review your cart and try again.',
            });
            return;
          }

          existingOrder.paymentStatus = 'unknown';
          existingOrder.failureReason = `Uncertain outcome during recovery: ${createErr.message || 'Unknown network error'}`;
          await existingOrder.save();

          const httpStatus =
            createErr.statusCode === 429 || createErr.status === 429 ? 429 : 504;
          res.status(httpStatus).json({
            success: false,
            message:
              httpStatus === 429
                ? 'Payment gateway rate limit exceeded. Your order outcome is being verified.'
                : 'Payment gateway communication timed out. Your order outcome is being verified.',
            resolutionNeeded: true,
          });
          return;
        }
      }

      // 3D. Definite Failure ('retryable_failure') -> Clean up old failure record so fresh reservation proceeds
      if (existingOrder.paymentStatus === 'retryable_failure') {
        await Order.deleteOne({ _id: existingOrder._id });
      }
    }

    // 4. Retrieve user's persistent cart from MongoDB
    const cart = await Cart.findOne({ user: userIdObj });

    if (!cart || !cart.items || cart.items.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Your shopping cart is empty. Please add projects before checking out.',
      });
      return;
    }

    // 5. Query canonical projects from database to verify availability and current prices
    const projectIds = cart.items
      .map((item: ICartItem) => (item.project ? item.project.toString() : null))
      .filter((id: string | null): id is string => Boolean(id));

    const projects = await Project.find({ _id: { $in: projectIds } });
    const projectMap = new Map<string, IProject>();
    for (const project of projects) {
      projectMap.set(project._id.toString(), project);
    }

    // 6. Validate items and construct immutable purchased-item snapshot
    const orderItems: IOrderItem[] = [];
    let calculatedTotal = 0;

    for (const item of cart.items) {
      const projIdStr = item.project ? item.project.toString() : '';
      const canonicalProject = projectMap.get(projIdStr);

      if (!canonicalProject) {
        res.status(400).json({
          success: false,
          message: 'One or more projects in your cart are no longer available in the catalog.',
        });
        return;
      }

      if ((canonicalProject as any).isActive === false) {
        res.status(400).json({
          success: false,
          message: `The project "${canonicalProject.title}" is currently unavailable for purchase.`,
        });
        return;
      }

      const unitPrice = canonicalProject.price;
      if (typeof unitPrice !== 'number' || unitPrice < 0) {
        res.status(400).json({
          success: false,
          message: `Invalid price configuration for project "${canonicalProject.title}".`,
        });
        return;
      }

      const itemTotal = unitPrice * item.quantity;
      calculatedTotal += itemTotal;

      orderItems.push({
        projectId: canonicalProject._id as mongoose.Types.ObjectId,
        cartItemId: item._id as mongoose.Types.ObjectId,
        projectSlug: canonicalProject.slug,
        title: canonicalProject.title,
        price: unitPrice,
        quantity: item.quantity,
        customization: item.customization || '',
        category: canonicalProject.category || '',
        subcategory: canonicalProject.subcategory || '',
        image: canonicalProject.image || '',
      });
    }

    calculatedTotal = Math.round(calculatedTotal * 100) / 100;
    const amountInPaise = Math.round(calculatedTotal * 100);

    if (amountInPaise <= 0 || !Number.isInteger(amountInPaise)) {
      res.status(400).json({
        success: false,
        message: 'Invalid cart total amount. Order cannot be processed.',
      });
      return;
    }

    // 7. Generate deterministic IDs strictly within 40 characters
    const { orderId, receipt } = generateOrderIdentifiers();

    // 8. ATOMIC RESERVATION in MongoDB in 'creating' state BEFORE calling Razorpay
    const reservationDoc = new Order({
      orderId,
      receipt,
      userId: userIdObj,
      items: orderItems,
      totalAmount: calculatedTotal,
      amountPaise: amountInPaise,
      currency: 'INR',
      status: 'pending',
      paymentStatus: 'creating',
      idempotencyKey,
    });

    try {
      await reservationDoc.save();
      reservedOrderDoc = reservationDoc;
    } catch (saveError: any) {
      // Code 11000 duplicate key: Another concurrent request won the reservation
      if (
        saveError.code === 11000 ||
        (saveError.name === 'MongoServerError' && saveError.code === 11000) ||
        (typeof saveError.message === 'string' && saveError.message.includes('E11000'))
      ) {
        await pollForOrderResolution(userIdObj, idempotencyKey, res);
        return;
      }

      console.error('Database reservation error for order creation:', saveError);
      res.status(500).json({
        success: false,
        message: 'Failed to record pending order in database.',
        error: process.env.NODE_ENV === 'production' ? undefined : saveError.message,
      });
      return;
    }

    // 9. ONLY the single winning request reaches this point to create Razorpay Order
    let razorpayOrder: { id: string; currency: string; amount: string | number };
    try {
      const razorpay = getRazorpayClient();
      razorpayOrder = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: reservationDoc.receipt, // Exact stored persistent receipt (<= 40 chars)
        notes: {
          orderId,
          receipt: reservationDoc.receipt,
          userId: userIdStr,
          itemCount: String(orderItems.length),
        },
      });
    } catch (razorpayError: any) {
      console.error('Razorpay order creation error:', razorpayError);

      // Check if Razorpay rejected because receipt already exists (duplicate receipt defense)
      if (isDuplicateReceiptError(razorpayError)) {
        const recheck = await reconcileRazorpayOrder(reservationDoc.receipt);
        if (recheck) {
          const isValid = isValidReconciliationMatch(recheck, {
            receipt: reservationDoc.receipt,
            amountInPaise,
            currency: 'INR',
          });
          if (isValid) {
            reservationDoc.razorpayOrderId = recheck.id;
            reservationDoc.paymentStatus = 'created';
            await reservationDoc.save();

            const keyId = getRazorpayKeyId();
            res.status(200).json({
              success: true,
              id: reservationDoc._id.toString(),
              _id: reservationDoc._id.toString(),
              orderId: reservationDoc.orderId,
              razorpayOrderId: reservationDoc.razorpayOrderId,
              amount: amountInPaise,
              currency: 'INR',
              keyId,
            });
            return;
          } else {
            // Mismatched gateway order found on duplicate receipt! Hold for manual resolution
            reservationDoc.paymentStatus = 'unknown';
            reservationDoc.failureReason =
              'Reconciliation validation failed: Mismatched gateway receipt, amount, or currency on duplicate receipt.';
            await reservationDoc.save();

            res.status(500).json({
              success: false,
              message: 'Payment gateway returned a mismatched order association. Order is held for resolution.',
              resolutionNeeded: true,
            });
            return;
          }
        }
      }

      const outcome = classifyRazorpayError(razorpayError);

      if (outcome === 'definite_rejection') {
        // Definite failure: Gateway rejected before creating order -> Release reservation
        if (reservedOrderDoc) {
          try {
            await Order.deleteOne({ _id: reservedOrderDoc._id, razorpayOrderId: { $exists: false } });
          } catch (cleanupErr) {
            console.error('Failed to clean up reservation after definite rejection:', cleanupErr);
          }
        }
        const clientStatus =
          razorpayError.statusCode === 401 || razorpayError.statusCode === 403 ? 502 : 400;
        res.status(clientStatus).json({
          success: false,
          message:
            clientStatus === 502
              ? 'Payment gateway authorization failed. Please contact support.'
              : 'Payment gateway rejected the order request. Please review your cart and try again.',
          error: process.env.NODE_ENV === 'production' ? undefined : razorpayError.message,
        });
        return;
      }

      // Uncertain outcome: Timeout, network drop, 408, 429, or 5xx -> Mark 'unknown', preserve reservation
      if (reservedOrderDoc) {
        try {
          reservedOrderDoc.paymentStatus = 'unknown';
          reservedOrderDoc.failureReason = `Uncertain payment gateway outcome: ${razorpayError.message || razorpayError.error?.description || 'Unknown network error'}`;
          await reservedOrderDoc.save();
        } catch (markErr) {
          console.error('Failed to update reservation to unknown:', markErr);
        }
      }

      const clientStatus =
        razorpayError.statusCode === 429 || razorpayError.status === 429 ? 429 : 504;
      res.status(clientStatus).json({
        success: false,
        message:
          clientStatus === 429
            ? 'Payment gateway rate limit exceeded. Your order outcome is being verified. Please do not retry immediately.'
            : 'Payment gateway communication timed out. Your order outcome is being verified. Please do not retry immediately.',
        resolutionNeeded: true,
      });
      return;
    }

    // 10. Update the reserved order with razorpayOrderId and transition to 'created'
    try {
      reservedOrderDoc.razorpayOrderId = razorpayOrder.id;
      reservedOrderDoc.paymentStatus = 'created';
      await reservedOrderDoc.save();
    } catch (updateDbError: any) {
      console.error(
        `CRITICAL BOUNDARY ERROR: Razorpay order ${razorpayOrder.id} created but failed to attach to internal order ${orderId}:`,
        updateDbError
      );
      // Attempt recovery update
      try {
        await Order.findByIdAndUpdate(reservedOrderDoc._id, {
          razorpayOrderId: razorpayOrder.id,
          paymentStatus: 'created',
        });
      } catch (recoveryErr) {
        console.error('Immediate recovery update failed:', recoveryErr);
      }

      res.status(500).json({
        success: false,
        message: 'Payment order created with gateway but failed to record in database. System will reconcile automatically on retry.',
        resolutionNeeded: true,
      });
      return;
    }

    // 11. Return checkout parameters
    const keyId = getRazorpayKeyId();
    res.status(201).json({
      success: true,
      id: reservedOrderDoc._id.toString(),
      _id: reservedOrderDoc._id.toString(),
      orderId: reservedOrderDoc.orderId,
      razorpayOrderId: reservedOrderDoc.razorpayOrderId,
      amount: amountInPaise,
      currency: 'INR',
      keyId,
    });
  } catch (error: any) {
    console.error('Unexpected error in createOrder:', error);
    res.status(500).json({
      success: false,
      message: 'An unexpected internal error occurred while processing your order.',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
}

/**
 * POST /api/orders/verify-payment
 * Verifies Razorpay payment signature for an authenticated user's order.
 * Strictly verifies user ownership, matching Razorpay order ID, and HMAC SHA-256 signature.
 * Enforces idempotency and prevents late callbacks from downgrading paid orders.
 */
export async function verifyPayment(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Authentication required to verify payment.',
      });
      return;
    }

    const {
      orderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    const userIdObj = new mongoose.Types.ObjectId(userId);

    // 1. Look up the internal order ensuring user ownership
    const order = await Order.findOne({
      orderId,
      userId: userIdObj,
    });

    if (!order) {
      res.status(404).json({
        success: false,
        message: 'Order not found.',
      });
      return;
    }

    // 2. Verify that the Razorpay order ID in callback matches the stored order's razorpayOrderId
    if (!order.razorpayOrderId || order.razorpayOrderId !== razorpay_order_id) {
      res.status(400).json({
        success: false,
        message: 'Razorpay order identifier mismatch.',
      });
      return;
    }

    // 3. Verify Razorpay HMAC SHA-256 signature
    const isValidSignature = verifyPaymentSignature({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
    });

    if (!isValidSignature) {
      res.status(400).json({
        success: false,
        message: 'Invalid payment signature. Verification failed.',
      });
      return;
    }

    // 4. Authoritatively verify with gateway and process payment capture atomically
    const { order: updatedOrder } = await processPaymentCapture({
      paymentId: razorpay_payment_id,
      orderId: order.orderId,
      razorpayOrderId: razorpay_order_id,
      amountPaise: order.amountPaise !== undefined ? order.amountPaise : Math.round(order.totalAmount * 100),
      currency: order.currency,
      signature: razorpay_signature,
      source: 'callback',
    });

    // 5. Return sanitized safe response
    res.status(200).json({
      success: true,
      message: 'Payment verified successfully.',
      order: {
        id: updatedOrder._id ? updatedOrder._id.toString() : undefined,
        _id: updatedOrder._id ? updatedOrder._id.toString() : undefined,
        orderId: updatedOrder.orderId,
        status: updatedOrder.status,
        paymentStatus: updatedOrder.paymentStatus,
        totalAmount: updatedOrder.totalAmount,
        currency: updatedOrder.currency,
        razorpayOrderId: updatedOrder.razorpayOrderId,
        razorpayPaymentId: updatedOrder.razorpayPaymentId,
        paidAt: updatedOrder.paidAt,
        items: updatedOrder.items,
      },
    });
  } catch (error: any) {
    if (
      error instanceof PaymentNotCapturedError ||
      error instanceof GatewayOrderMismatchError ||
      error instanceof GatewayAmountMismatchError ||
      error instanceof GatewayCurrencyMismatchError ||
      error instanceof SecurityDiscrepancyError ||
      error instanceof MissingCanonicalAmountError
    ) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof OrderNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    console.error('Unexpected error in verifyPayment:', error);
    res.status(500).json({
      success: false,
      message: 'An unexpected error occurred while verifying the payment.',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
}

export type CustomerFacingPaymentStatus =
  | 'pending'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'refund_pending';

export type CustomerFacingOrderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refunded';

/**
 * Maps internal payment states to customer-facing payment statuses.
 * Strictly prevents leaking internal payment-processing or security states:
 * - 'security_discrepancy' -> 'failed'
 * - 'held_for_review' -> 'pending' (or 'captured' if completed)
 * - 'creating' -> 'pending'
 * - 'unknown' -> 'pending'
 * - 'retryable_failure' -> 'failed'
 * - 'duplicate_charge_detected' -> 'captured'
 * - 'created' -> 'pending'
 * - 'authorized' -> 'pending'
 */
export function mapCustomerPaymentStatus(
  internalPaymentStatus?: string,
  orderStatus?: string
): CustomerFacingPaymentStatus {
  switch (internalPaymentStatus) {
    case 'captured':
    case 'duplicate_charge_detected':
      return 'captured';

    case 'refunded':
      return 'refunded';

    case 'partially_refunded':
      return 'partially_refunded';

    case 'refund_pending':
      return 'refund_pending';

    case 'failed':
    case 'retryable_failure':
    case 'security_discrepancy':
      return 'failed';

    case 'creating':
    case 'created':
    case 'authorized':
    case 'unknown':
      return 'pending';

    case 'held_for_review':
      return orderStatus === 'completed' ? 'captured' : 'pending';

    default:
      return 'pending';
  }
}

/**
 * Maps internal order status to customer-facing order status.
 * Ensures security discrepancy or failed payment reflects as failed order.
 */
export function mapCustomerOrderStatus(
  orderStatus?: string,
  internalPaymentStatus?: string
): CustomerFacingOrderStatus {
  if (
    internalPaymentStatus === 'security_discrepancy' ||
    internalPaymentStatus === 'failed' ||
    internalPaymentStatus === 'retryable_failure'
  ) {
    if (orderStatus !== 'completed' && orderStatus !== 'refunded') {
      return 'failed';
    }
  }

  switch (orderStatus) {
    case 'completed':
      return 'completed';
    case 'processing':
      return 'processing';
    case 'refunded':
      return 'refunded';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'pending':
    default:
      return 'pending';
  }
}

/**
 * Sanitizes an internal Order document into a safe customer-facing representation.
 * Guarantees:
 * 1. Uses canonical server-side stored historical values (item prices and totalAmount);
 *    never reconstructs historical prices from current Project catalog prices.
 * 2. Strictly omits internal secrets, dual-ledger accounting fields, receipt tokens,
 *    internal lease tokens, provider idempotency keys, and webhook records.
 * 3. Maps internal payment-processing and security states (e.g. security_discrepancy,
 *    held_for_review, creating, unknown, duplicate_charge_detected) to clean customer-facing statuses.
 */
export function formatCustomerOrder(order: any) {
  const confirmedRefundPaise =
    typeof order.confirmedRefundPaise === 'number' ? order.confirmedRefundPaise : 0;
  const isRefunded = order.status === 'refunded' || order.paymentStatus === 'refunded';
  const isPartiallyRefunded =
    order.paymentStatus === 'partially_refunded' || (confirmedRefundPaise > 0 && !isRefunded);

  const customerPaymentStatus = mapCustomerPaymentStatus(order.paymentStatus, order.status);
  const customerOrderStatus = mapCustomerOrderStatus(order.status, order.paymentStatus);

  const items = Array.isArray(order.items)
    ? order.items.map((item: any) => ({
        projectId: item.projectId ? item.projectId.toString() : '',
        projectSlug: item.projectSlug || '',
        title: item.title || '',
        price: typeof item.price === 'number' ? item.price : 0,
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        customization: item.customization || '',
        category: item.category || '',
        subcategory: item.subcategory || '',
        image: item.image || '',
      }))
    : [];

  const totalItemCount = items.reduce((acc: number, item: any) => acc + item.quantity, 0);
  const docId = order._id ? order._id.toString() : '';

  return {
    _id: docId,
    id: docId,
    orderId: order.orderId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: customerOrderStatus,
    paymentStatus: customerPaymentStatus,
    totalAmount: typeof order.totalAmount === 'number' ? order.totalAmount : 0,
    currency: order.currency || 'INR',
    items,
    itemCount: totalItemCount,
    paidAt: order.paidAt || null,
    paymentMethod: order.paymentMethod || null,
    razorpayOrderId: order.razorpayOrderId || null,
    razorpayPaymentId: order.razorpayPaymentId || null,
    refundSummary: {
      isRefunded,
      isPartiallyRefunded,
      refundedAmount: Math.round((confirmedRefundPaise / 100) * 100) / 100,
    },
  };
}

/**
 * GET /api/orders
 * Returns paginated order history for the authenticated user.
 * - Enforces user ownership strictly at the database query level.
 * - Never accepts a user ID from query parameters to determine ownership.
 * - Supports pagination (page, limit) and optional filtering (status, paymentStatus).
 * - Sorts most recent orders first (createdAt: -1).
 * - Excludes internal-only states from filter inputs and query results.
 */
export async function getOrders(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in to view your orders.',
      });
      return;
    }

    let userIdObj: mongoose.Types.ObjectId;
    try {
      userIdObj = new mongoose.Types.ObjectId(req.user.id);
    } catch {
      res.status(401).json({
        success: false,
        message: 'Invalid user authentication token.',
      });
      return;
    }

    const page = typeof req.query.page === 'number' ? req.query.page : 1;
    const limit = typeof req.query.limit === 'number' ? req.query.limit : 10;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const paymentStatus =
      typeof req.query.paymentStatus === 'string' ? req.query.paymentStatus : undefined;

    // Enforce ownership strictly at the database level
    const conditions: any[] = [{ userId: userIdObj }];

    if (status) {
      if (status === 'failed') {
        conditions.push({
          $or: [
            { status: 'failed' },
            { paymentStatus: { $in: ['failed', 'retryable_failure', 'security_discrepancy'] } },
          ],
        });
      } else {
        conditions.push({ status });
      }
    }

    if (paymentStatus) {
      switch (paymentStatus) {
        case 'pending':
          conditions.push({
            $or: [
              {
                paymentStatus: {
                  $in: ['creating', 'created', 'authorized', 'unknown'],
                },
              },
              {
                paymentStatus: 'held_for_review',
                status: { $ne: 'completed' },
              },
            ],
          });
          break;
        case 'captured':
          conditions.push({
            $or: [
              {
                paymentStatus: {
                  $in: ['captured', 'duplicate_charge_detected'],
                },
              },
              {
                paymentStatus: 'held_for_review',
                status: 'completed',
              },
            ],
          });
          break;
        case 'failed':
          conditions.push({
            paymentStatus: {
              $in: ['failed', 'retryable_failure', 'security_discrepancy'],
            },
          });
          break;
        case 'refunded':
          conditions.push({ paymentStatus: 'refunded' });
          break;
        case 'partially_refunded':
          conditions.push({ paymentStatus: 'partially_refunded' });
          break;
        case 'refund_pending':
          conditions.push({ paymentStatus: 'refund_pending' });
          break;
      }
    }

    const queryFilter = conditions.length === 1 ? conditions[0] : { $and: conditions };

    const total = await Order.countDocuments(queryFilter);
    const skip = (page - 1) * limit;

    const orders = await Order.find(queryFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const hasNextPage = totalPages > 0 && page < totalPages;
    const hasPrevPage = totalPages > 0 && page > 1;

    res.status(200).json({
      success: true,
      orders: orders.map(formatCustomerOrder),
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage,
        hasPrevPage,
      },
    });
  } catch (error: any) {
    console.error('Unexpected error in getOrders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve order history.',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
}

/**
 * GET /api/orders/:id
 * Returns complete order details for a specific order owned by the authenticated user.
 * - Strictly validates MongoDB ObjectId format.
 * - Enforces user ownership at the database query level.
 * - Returns 404 for nonexistent orders and orders belonging to other users without leaking existence.
 * - Sanitizes all sensitive internal gateway / dual-ledger / worker fields.
 */
export async function getOrderById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in to view order details.',
      });
      return;
    }

    let userIdObj: mongoose.Types.ObjectId;
    try {
      userIdObj = new mongoose.Types.ObjectId(req.user.id);
    } catch {
      res.status(401).json({
        success: false,
        message: 'Invalid user authentication token.',
      });
      return;
    }

    const { id } = req.params;
    let orderObjectId: mongoose.Types.ObjectId;
    try {
      orderObjectId = new mongoose.Types.ObjectId(id);
    } catch {
      res.status(400).json({
        success: false,
        message: 'Invalid order ID format. Must be a valid MongoDB ObjectId.',
      });
      return;
    }

    // Look up by _id and authenticated userId to strictly prevent unauthorized access or existence leaking
    const order = await Order.findOne({
      _id: orderObjectId,
      userId: userIdObj,
    })
      .lean()
      .exec();

    if (!order) {
      res.status(404).json({
        success: false,
        message: 'Order not found.',
      });
      return;
    }

    res.status(200).json({
      success: true,
      order: formatCustomerOrder(order),
    });
  } catch (error: any) {
    console.error('Unexpected error in getOrderById:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve order details.',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
}
