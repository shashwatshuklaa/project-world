import crypto from 'crypto';
import { IOrder } from '../models/Order.js';
import { Cart } from '../models/Cart.js';
import { getRazorpayKeySecret, getRazorpayWebhookSecret } from '../config/razorpay.js';
import { isConcurrencyConflict, MAX_CONCURRENCY_RETRIES } from '../controllers/cart.controller.js';
import {
  processPaymentCapture,
  fetchAndVerifyGatewayPayment,
  withPaymentTransaction,
  isTransactionUnsupportedError,
  isTransientTransactionError,
  PaymentNotCapturedError,
  GatewayOrderMismatchError,
  GatewayAmountMismatchError,
  GatewayCurrencyMismatchError,
  OrderNotFoundError,
  SecurityDiscrepancyError,
  TransactionSupportError,
  MissingCanonicalAmountError,
  type CaptureProcessingResult,
  type ProcessPaymentCaptureParams,
} from './capture.service.js';
import {
  reserveRefund,
  getRemainingRefundableCapacity,
  generateRefundReservationId,
  isDuplicateKeyError,
  PaymentNotFoundError,
  OrderStateInvalidForRefundError,
  InvalidRefundAmountError,
  InvalidCurrencyError,
  InvalidIdempotencyKeyError,
  RefundAmountExceedsRemainingError,
  IdempotencyConflictError,
  type ReserveRefundParams,
  type ReserveRefundResult,
  type RemainingRefundableCapacity,
} from './refund.service.js';
import {
  claimRefundJob,
  dispatchRefundJob,
  recoverExpiredLeases,
  generateProviderRefundIdempotencyKey,
  classifyGatewayError,
  ensureRazorpayClientInterceptor,
  getActiveRefundDispatchContext,
  refundDispatchStorage,
  RefundJobNotFoundError,
  RefundJobNotClaimedError,
  StaleWorkerLeaseError,
  InvalidJobStateForDispatchError,
  PermanentGatewayError,
  UncertainGatewayError,
  type ClaimRefundJobParams,
  type DispatchRefundJobParams,
  type DispatchRefundResult,
  type RecoverExpiredLeasesOptions,
  type RecoverExpiredLeasesResult,
  type GatewayErrorClassification,
  type RefundDispatchContext,
} from './refund-dispatch.service.js';
import {
  processRefundSettlement,
  processRefundFailure,
  fetchAuthoritativeGatewayRefund,
  RefundNotFoundError,
  RefundIdentityMismatchError,
  RefundAmountMismatchError,
  RefundCurrencyMismatchError,
  StaleRefundEventError,
  PaymentAttemptNotFoundError,
  PaymentNotCapturedForRefundError,
  OrderNotFoundForRefundError,
  GatewayRefundPendingError,
  GatewayRefundVerificationError,
  type ProcessRefundSettlementParams,
  type ProcessRefundSettlementResult,
  type ProcessRefundFailureParams,
  type ProcessRefundFailureResult,
} from './refund-settlement.service.js';

export {
  processPaymentCapture,
  fetchAndVerifyGatewayPayment,
  withPaymentTransaction,
  isTransactionUnsupportedError,
  isTransientTransactionError,
  PaymentNotCapturedError,
  GatewayOrderMismatchError,
  GatewayAmountMismatchError,
  GatewayCurrencyMismatchError,
  OrderNotFoundError,
  SecurityDiscrepancyError,
  TransactionSupportError,
  MissingCanonicalAmountError,
  reserveRefund,
  getRemainingRefundableCapacity,
  generateRefundReservationId,
  isDuplicateKeyError,
  PaymentNotFoundError,
  OrderStateInvalidForRefundError,
  InvalidRefundAmountError,
  InvalidCurrencyError,
  InvalidIdempotencyKeyError,
  RefundAmountExceedsRemainingError,
  IdempotencyConflictError,
  claimRefundJob,
  dispatchRefundJob,
  recoverExpiredLeases,
  generateProviderRefundIdempotencyKey,
  classifyGatewayError,
  ensureRazorpayClientInterceptor,
  getActiveRefundDispatchContext,
  refundDispatchStorage,
  RefundJobNotFoundError,
  RefundJobNotClaimedError,
  StaleWorkerLeaseError,
  InvalidJobStateForDispatchError,
  PermanentGatewayError,
  UncertainGatewayError,
  processRefundSettlement,
  processRefundFailure,
  fetchAuthoritativeGatewayRefund,
  RefundNotFoundError,
  RefundIdentityMismatchError,
  RefundAmountMismatchError,
  RefundCurrencyMismatchError,
  StaleRefundEventError,
  PaymentAttemptNotFoundError,
  PaymentNotCapturedForRefundError,
  OrderNotFoundForRefundError,
  GatewayRefundPendingError,
  GatewayRefundVerificationError,
};
export type {
  CaptureProcessingResult,
  ProcessPaymentCaptureParams,
  ReserveRefundParams,
  ReserveRefundResult,
  RemainingRefundableCapacity,
  ClaimRefundJobParams,
  DispatchRefundJobParams,
  DispatchRefundResult,
  RecoverExpiredLeasesOptions,
  RecoverExpiredLeasesResult,
  GatewayErrorClassification,
  RefundDispatchContext,
  ProcessRefundSettlementParams,
  ProcessRefundSettlementResult,
  ProcessRefundFailureParams,
  ProcessRefundFailureResult,
};

/**
 * Constant-time string comparison utility using crypto.timingSafeEqual.
 * Always verifies that buffers have identical byte lengths before comparing,
 * preventing timing side-channel attacks and RangeError exceptions.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the Razorpay frontend payment signature using HMAC SHA-256.
 * The signature payload is strictly: `${razorpay_order_id}|${razorpay_payment_id}`.
 */
export function verifyPaymentSignature(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): boolean {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = params;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return false;
  }

  const keySecret = getRazorpayKeySecret();
  const payload = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(payload)
    .digest('hex');

  return timingSafeCompare(expectedSignature, razorpaySignature);
}

/**
 * Verifies an incoming Razorpay webhook signature against the exact raw HTTP request body.
 * Never serializes JSON; uses the exact incoming bytes.
 */
export function verifyWebhookSignature(params: {
  rawBody: Buffer | string;
  signature: string;
}): boolean {
  const { rawBody, signature } = params;

  if (!rawBody || !signature) {
    return false;
  }

  const webhookSecret = getRazorpayWebhookSecret();
  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBuffer)
    .digest('hex');

  return timingSafeCompare(expectedSignature, signature);
}

/**
 * Reconciles the user's persistent cart after successful payment:
 * 1. Deducts only the specific purchased quantities from matching cart lines.
 * 2. Preserves newly added projects or additional items added during checkout.
 * 3. Preserves remaining quantity if the user increased the quantity while checkout was pending.
 * 4. Preserves cart lines if customization notes were modified.
 * 5. Guarantees idempotency so multiple callbacks do not deduct items multiple times.
 */
export async function reconcileCartAfterPayment(order: IOrder): Promise<void> {
  // Idempotency: skip if cart deduction has already been performed for this order
  if (order.cartReconciled) {
    return;
  }

  const userId = order.userId;
  let attempts = 0;

  while (attempts < MAX_CONCURRENCY_RETRIES) {
    attempts++;
    try {
      const cart = await Cart.findOne({ user: userId });
      if (!cart || !cart.items || cart.items.length === 0) {
        return;
      }

      let modified = false;

      // Reconcile each purchased snapshot item against current cart lines
      for (const purchasedItem of order.items) {
        const targetProjId = purchasedItem.projectId.toString();
        const targetCustomization = (purchasedItem.customization || '').trim();
        const qtyToDeduct = purchasedItem.quantity;

        // Search for matching cart item:
        // Priority 1: Match cartItemId + projectId + customization
        let itemIndex = -1;
        if (purchasedItem.cartItemId) {
          const targetCartItemId = purchasedItem.cartItemId.toString();
          itemIndex = cart.items.findIndex(
            (ci: any) =>
              ci._id?.toString() === targetCartItemId &&
              ci.project?.toString() === targetProjId &&
              (ci.customization || '').trim() === targetCustomization
          );
        }

        // Priority 2: Fallback to match by projectId + exact customization
        if (itemIndex === -1) {
          itemIndex = cart.items.findIndex(
            (ci: any) =>
              ci.project?.toString() === targetProjId &&
              (ci.customization || '').trim() === targetCustomization
          );
        }

        if (itemIndex !== -1) {
          const cartItem = cart.items[itemIndex];
          if (cartItem.quantity > qtyToDeduct) {
            // User added more quantity while checkout was pending -> retain difference
            cartItem.quantity -= qtyToDeduct;
            modified = true;
          } else {
            // Purchased all or more -> remove the line
            cart.items.splice(itemIndex, 1);
            modified = true;
          }
        }
      }

      if (modified) {
        await cart.save();
      }
      return;
    } catch (err: any) {
      if (isConcurrencyConflict(err) && attempts < MAX_CONCURRENCY_RETRIES) {
        continue;
      }
      console.warn(`[Payment Service] Cart reconciliation conflict/error for order ${order.orderId}:`, err);
      return;
    }
  }
}

/**
 * Transitions an internal order to captured/paid state:
 * - Persists payment ID, signature, payment method, and timestamps.
 * - Enforces idempotency: repeated executions will not duplicate fulfillment.
 * - Reconciles user cart once.
 */
export async function processSuccessfulPayment(params: {
  order: IOrder;
  paymentId: string;
  signature?: string;
  paymentMethod?: string;
  eventId?: string;
}): Promise<IOrder> {
  const { order, paymentId, signature, paymentMethod, eventId } = params;

  const wasAlreadyCaptured =
    order.paymentStatus === 'captured' || order.status === 'completed';

  order.paymentStatus = 'captured';
  order.status = 'completed';

  if (paymentId && (!order.razorpayPaymentId || order.razorpayPaymentId.startsWith('webhook_'))) {
    order.razorpayPaymentId = paymentId;
  }
  if (signature && !order.razorpaySignature) {
    order.razorpaySignature = signature;
  }
  if (paymentMethod && !order.paymentMethod) {
    order.paymentMethod = paymentMethod;
  }
  if (!order.paidAt) {
    order.paidAt = new Date();
  }
  if (eventId && !order.webhookEventsProcessed.includes(eventId)) {
    order.webhookEventsProcessed.push(eventId);
  }

  // Deduct cart items only once
  if (!wasAlreadyCaptured && !order.cartReconciled) {
    await reconcileCartAfterPayment(order);
    order.cartReconciled = true;
  }

  await order.save();
  return order;
}

/**
 * Handles a payment failure event:
 * - Does NOT permanently cancel or fail the order if another payment attempt can still succeed.
 * - Never downgrades an already captured or paid order.
 */
export async function processPaymentFailed(params: {
  order: IOrder;
  reason?: string;
  eventId?: string;
}): Promise<IOrder> {
  const { order, reason, eventId } = params;

  // Never downgrade a captured, completed, or refunded order
  if (
    order.paymentStatus === 'captured' ||
    order.status === 'completed' ||
    order.status === 'refunded'
  ) {
    return order;
  }

  order.paymentStatus = 'retryable_failure';
  order.failureReason = reason || 'Payment attempt failed';

  if (eventId && !order.webhookEventsProcessed.includes(eventId)) {
    order.webhookEventsProcessed.push(eventId);
  }

  await order.save();
  return order;
}

/**
 * Handles a refund event:
 * - Transitions order status to 'refunded'.
 */
export async function processRefund(params: {
  order: IOrder;
  refundId?: string;
  eventId?: string;
}): Promise<IOrder> {
  const { order, refundId, eventId } = params;

  order.paymentStatus = 'refunded';
  order.status = 'refunded';
  if (refundId) {
    order.failureReason = `Refund processed: ${refundId}`;
  }

  if (eventId && !order.webhookEventsProcessed.includes(eventId)) {
    order.webhookEventsProcessed.push(eventId);
  }

  await order.save();
  return order;
}
