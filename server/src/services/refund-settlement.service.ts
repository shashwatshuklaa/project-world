import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund } from '../models/Refund.js';
import { RefundJob, IRefundJob } from '../models/RefundJob.js';
import { getRazorpayClient } from '../config/razorpay.js';
import { withPaymentTransaction } from './capture.service.js';

// ============================================================================
// CUSTOM ERROR CLASSES FOR REFUND SETTLEMENT & RECONCILIATION
// ============================================================================

export class RefundNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundNotFoundError';
  }
}

export class RefundIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundIdentityMismatchError';
  }
}

export class RefundAmountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundAmountMismatchError';
  }
}

export class RefundCurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundCurrencyMismatchError';
  }
}

export class StaleRefundEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRefundEventError';
  }
}

export class PaymentAttemptNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentAttemptNotFoundError';
  }
}

export class PaymentNotCapturedForRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotCapturedForRefundError';
  }
}

export class OrderNotFoundForRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundForRefundError';
  }
}

export class GatewayRefundPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRefundPendingError';
  }
}

export class GatewayRefundVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayRefundVerificationError';
  }
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ProcessRefundSettlementParams {
  refundId: string; // Razorpay refund ID (rfnd_xxx) or internal refund reservation ID
  paymentId?: string; // Razorpay payment ID (pay_xxx)
  razorpayOrderId?: string; // Optional Razorpay order ID (order_xxx)
  amountPaise: number; // Integer paise reported by gateway
  currency?: string; // Strictly INR
  eventId?: string; // Webhook event ID
  source?: 'webhook' | 'reconciliation_worker' | 'manual_verification';
  gatewayRefund?: any; // Pre-verified gateway entity if fetched
  fetchGatewayState?: boolean; // Set true to explicitly fetch from Razorpay API
  notes?: Record<string, any>;
  razorpayClient?: any;
}

export interface ProcessRefundSettlementResult {
  status: 'settled' | 'already_settled';
  refund: IRefund;
  order: IOrder;
  refundJob?: IRefundJob | null;
  duplicateDelivery?: boolean;
}

export interface ProcessRefundFailureParams {
  refundId: string;
  paymentId?: string;
  razorpayOrderId?: string;
  failureReason?: string;
  eventId?: string;
  gatewayRefund?: any;
  fetchGatewayState?: boolean; // Set true to explicitly fetch from Razorpay API
  notes?: Record<string, any>;
  razorpayClient?: any;
}

export interface ProcessRefundFailureResult {
  status: 'failed_recorded' | 'already_failed';
  refund: IRefund;
  order: IOrder;
  refundJob?: IRefundJob | null;
  duplicateDelivery?: boolean;
}

// ============================================================================
// AUTHORITATIVE GATEWAY LOOKUP VIA RAZORPAY SDK
// ============================================================================

/**
 * Authoritatively fetches the refund entity directly from Razorpay using the official SDK.
 * Supports client.refunds.fetch(refundId) and client.payments.fetchRefund(paymentId, refundId).
 */
export async function fetchAuthoritativeGatewayRefund(
  refundId: string,
  paymentId?: string,
  razorpayClient?: any
): Promise<any> {
  const client = razorpayClient || getRazorpayClient();
  if (!client) {
    throw new GatewayRefundVerificationError('Razorpay client is not configured for authoritative refund lookup.');
  }

  try {
    if (client.refunds && typeof client.refunds.fetch === 'function') {
      const params = paymentId ? { payment_id: paymentId } : undefined;
      return await client.refunds.fetch(refundId, params);
    } else if (client.payments && typeof client.payments.fetchRefund === 'function' && paymentId) {
      return await client.payments.fetchRefund(paymentId, refundId);
    }
  } catch (err: any) {
    if (err instanceof GatewayRefundVerificationError) throw err;
    throw new GatewayRefundVerificationError(
      `Razorpay gateway lookup failed for refund ${refundId}: ${err?.message || err}`
    );
  }

  throw new GatewayRefundVerificationError(
    'Installed Razorpay SDK client does not support refunds.fetch or payments.fetchRefund.'
  );
}

// ============================================================================
// REFUND RESOLUTION HELPER
// ============================================================================

/**
 * Locates the target Refund record using providerRefundId, refundId, refundJobId, or paymentId.
 */
async function locateRefundDocument(
  params: {
    refundId: string;
    paymentId?: string;
    amountPaise?: number;
    notes?: Record<string, any>;
  },
  session?: mongoose.ClientSession | null
): Promise<IRefund | null> {
  const { refundId, paymentId, amountPaise, notes } = params;

  // 1. Direct match on providerRefundId or refundId
  const directQuery: any = {
    $or: [{ providerRefundId: refundId.trim() }, { refundId: refundId.trim() }],
  };
  const directQueryBuilder = Refund.findOne(directQuery);
  if (session) directQueryBuilder.session(session);
  const directRefund = await directQueryBuilder;
  if (directRefund) return directRefund;

  // 2. Match via refundJobId in notes
  if (notes?.refundJobId && mongoose.Types.ObjectId.isValid(notes.refundJobId)) {
    const jobQueryBuilder = Refund.findOne({ refundJobId: new mongoose.Types.ObjectId(notes.refundJobId) });
    if (session) jobQueryBuilder.session(session);
    const jobRefund = await jobQueryBuilder;
    if (jobRefund) return jobRefund;
  }

  // 3. Fallback: match by paymentId and exact amount if pending
  if (paymentId && amountPaise) {
    const paymentQueryBuilder = Refund.findOne({
      paymentId: paymentId.trim(),
      amountPaise,
      status: 'pending',
    });
    if (session) paymentQueryBuilder.session(session);
    const paymentRefund = await paymentQueryBuilder;
    if (paymentRefund) return paymentRefund;
  }

  return null;
}

// ============================================================================
// AUTHORITATIVE REFUND SETTLEMENT (refund.processed)
// ============================================================================

/**
 * Authoritatively settles a previously reserved or dispatched refund upon receipt
 * of an authoritative refund.processed event or reconciliation confirmation.
 *
 * Requirements:
 * 1. Verifies refund ID, payment ID, order ID, amount, and currency.
 * 2. Idempotent: duplicate events return success without double-settling.
 * 3. Rejects stale events (e.g. attempting to settle an already failed refund).
 * 4. Moves exact amount from amountReservedRefundPaise to confirmedRefundPaise.
 * 5. Updates purchaseRefundedPaise or duplicateRefundedPaise based on refund type.
 * 6. Updates paymentStatus to 'partially_refunded' or 'refunded' only when primary capacity justifies it.
 * 7. Never marks entire order refunded after a partial refund.
 * 8. Executes atomically in a MongoDB transaction.
 */
export async function processRefundSettlement(
  params: ProcessRefundSettlementParams
): Promise<ProcessRefundSettlementResult> {
  const {
    refundId,
    paymentId,
    razorpayOrderId,
    amountPaise,
    currency = 'INR',
    eventId,
    source = 'webhook',
    notes,
    razorpayClient,
  } = params;

  if (!refundId || !refundId.trim()) {
    throw new RefundNotFoundError('A valid refund ID is required for settlement.');
  }

  // 1. Authoritative Gateway Verification: do not trust unverified inputs
  let gatewayRefund = params.gatewayRefund;
  if (!gatewayRefund) {
    gatewayRefund = await fetchAuthoritativeGatewayRefund(refundId, paymentId, razorpayClient);
  }

  if (!gatewayRefund) {
    throw new GatewayRefundVerificationError(
      `Gateway refund retrieval returned no entity for refund ${refundId}. Settlement aborted.`
    );
  }

  // Authoritative Gateway Status Validation: status must be 'processed'
  if (gatewayRefund.status === 'pending') {
    throw new GatewayRefundPendingError(
      `Authoritative gateway indicates refund ${refundId} is still pending. Cannot settle until gateway confirms processed.`
    );
  }

  if (gatewayRefund.status !== 'processed') {
    throw new RefundIdentityMismatchError(
      `Authoritative gateway lookup indicates refund ${refundId} has status "${gatewayRefund.status}", expected "processed".`
    );
  }

  // Authoritative Gateway Field Validations
  if (gatewayRefund.id && gatewayRefund.id.trim() !== refundId.trim()) {
    throw new RefundIdentityMismatchError(
      `Gateway refund ID mismatch: gateway reports "${gatewayRefund.id}", expected "${refundId}".`
    );
  }

  if (paymentId && gatewayRefund.payment_id && gatewayRefund.payment_id.trim() !== paymentId.trim()) {
    throw new RefundIdentityMismatchError(
      `Gateway payment ID mismatch: gateway reports "${gatewayRefund.payment_id}", expected "${paymentId}".`
    );
  }

  if (gatewayRefund.amount !== undefined && amountPaise !== undefined && gatewayRefund.amount !== amountPaise) {
    throw new RefundAmountMismatchError(
      `Gateway refund amount mismatch: gateway reports ${gatewayRefund.amount} paise, event reports ${amountPaise} paise.`
    );
  }

  const gwCurrency = (gatewayRefund.currency || '').trim().toUpperCase();
  if (gwCurrency && gwCurrency !== 'INR') {
    throw new RefundCurrencyMismatchError(
      `Gateway refund currency mismatch: gateway reports "${gwCurrency}", strictly INR required.`
    );
  }

  // 2. Execute Settlement Atomically in a MongoDB Transaction
  return await withPaymentTransaction(async (session) => {
    // A. Locate the internal Refund record
    const refund = await locateRefundDocument({ refundId, paymentId, amountPaise, notes }, session);

    if (!refund) {
      throw new RefundNotFoundError(
        `No internal Refund record found matching refundId "${refundId}" or paymentId "${paymentId}".`
      );
    }

    // B. Stale & Idempotency Checks
    if (refund.status === 'settled') {
      // Duplicate event delivery: return idempotent success without altering financial totals
      const orderQuery = Order.findById(refund.orderId);
      if (session) orderQuery.session(session);
      const existingOrder = await orderQuery;

      if (!existingOrder) {
        throw new OrderNotFoundForRefundError(`Order ${refund.orderId} associated with settled refund not found.`);
      }

      let existingJob: IRefundJob | null = null;
      if (refund.refundJobId) {
        const jobQuery = RefundJob.findById(refund.refundJobId);
        if (session) jobQuery.session(session);
        existingJob = await jobQuery;
      }

      return {
        status: 'already_settled',
        refund,
        order: existingOrder,
        refundJob: existingJob,
        duplicateDelivery: true,
      };
    }

    if (refund.status === 'failed') {
      throw new StaleRefundEventError(
        `Stale event rejected: Refund ${refund.refundId} was previously marked failed and its reservation was released. Cannot settle a failed refund.`
      );
    }

    // C. Verify Associated PaymentAttempt
    const attemptQuery = PaymentAttempt.findOne({ paymentId: refund.paymentId });
    if (session) attemptQuery.session(session);
    const paymentAttempt = await attemptQuery;

    if (!paymentAttempt) {
      throw new PaymentAttemptNotFoundError(
        `Payment attempt "${refund.paymentId}" associated with refund ${refund.refundId} was not found.`
      );
    }

    if (paymentAttempt.status !== 'captured') {
      throw new PaymentNotCapturedForRefundError(
        `Payment attempt "${refund.paymentId}" has status "${paymentAttempt.status}". Only captured payments can have settled refunds.`
      );
    }

    if (paymentAttempt.orderId.toString() !== refund.orderId.toString()) {
      throw new RefundIdentityMismatchError(
        `Payment attempt order mismatch: Payment ${paymentAttempt.paymentId} belongs to Order ${paymentAttempt.orderId}, ` +
          `but Refund ${refund.refundId} belongs to Order ${refund.orderId}.`
      );
    }

    if (paymentId && paymentId.trim() !== refund.paymentId) {
      throw new RefundIdentityMismatchError(
        `Payment ID mismatch: Incoming event reports payment "${paymentId}", but Refund ${refund.refundId} is associated with "${refund.paymentId}".`
      );
    }

    if (gatewayRefund.payment_id && gatewayRefund.payment_id.trim() !== refund.paymentId.trim()) {
      throw new RefundIdentityMismatchError(
        `Authoritative gateway refund payment ID (${gatewayRefund.payment_id}) does not match reserved payment ID (${refund.paymentId}).`
      );
    }

    // D. Verify Amount & Currency
    if (amountPaise !== undefined && amountPaise !== refund.amountPaise) {
      throw new RefundAmountMismatchError(
        `Refund amount mismatch: Incoming event reports ${amountPaise} paise, but Refund ${refund.refundId} reserved ${refund.amountPaise} paise.`
      );
    }

    if (gatewayRefund.amount !== undefined && gatewayRefund.amount !== refund.amountPaise) {
      throw new RefundAmountMismatchError(
        `Authoritative gateway refund amount (${gatewayRefund.amount} paise) does not match reserved amount (${refund.amountPaise} paise).`
      );
    }

    const normalizedCurrency = (currency || 'INR').trim().toUpperCase();
    if (normalizedCurrency !== 'INR' || refund.currency !== 'INR') {
      throw new RefundCurrencyMismatchError(
        `Refund currency mismatch: Only INR is supported (event currency: "${normalizedCurrency}", refund currency: "${refund.currency}").`
      );
    }

    // E. Verify Associated Order
    const orderQuery = Order.findById(refund.orderId);
    if (session) orderQuery.session(session);
    const order = await orderQuery;

    if (!order) {
      throw new OrderNotFoundForRefundError(
        `Order ${refund.orderId} associated with Refund ${refund.refundId} was not found.`
      );
    }

    if (razorpayOrderId && order.razorpayOrderId && razorpayOrderId.trim() !== order.razorpayOrderId) {
      throw new RefundIdentityMismatchError(
        `Razorpay order ID mismatch: Event reports "${razorpayOrderId}", but Order ${order.orderId} has "${order.razorpayOrderId}".`
      );
    }

    // F. Verify Associated RefundJob (if linked)
    let refundJob: IRefundJob | null = null;
    if (refund.refundJobId) {
      const jobQuery = RefundJob.findById(refund.refundJobId);
      if (session) jobQuery.session(session);
      refundJob = await jobQuery;

      if (!refundJob) {
        throw new RefundIdentityMismatchError(
          `RefundJob ${refund.refundJobId} referenced by Refund ${refund.refundId} was not found.`
        );
      }

      if (refundJob.orderId.toString() !== order._id.toString()) {
        throw new RefundIdentityMismatchError(
          `RefundJob order association mismatch: Job ${refundJob._id} belongs to Order ${refundJob.orderId}, expected ${order._id}.`
        );
      }

      if (refundJob.targetPaymentId !== refund.paymentId) {
        throw new RefundIdentityMismatchError(
          `RefundJob target payment mismatch: Job target is "${refundJob.targetPaymentId}", expected "${refund.paymentId}".`
        );
      }

      if (refundJob.targetAmountPaise !== refund.amountPaise) {
        throw new RefundAmountMismatchError(
          `RefundJob target amount mismatch: Job target is ${refundJob.targetAmountPaise} paise, expected ${refund.amountPaise} paise.`
        );
      }
    }

    // G. Transition Refund State to 'settled'
    const now = new Date();
    refund.status = 'settled';
    refund.settledAt = now;
    refund.settlementSource = source;
    refund.settlementVerifiedAt = now;
    if (!refund.providerRefundId) {
      refund.providerRefundId = refundId.trim();
    }

    // H. Move Accounting Amounts Atomically on Order
    // Deduct exact reserved amount, increment confirmed refund amount
    const reservedCurrent = order.amountReservedRefundPaise || 0;
    order.amountReservedRefundPaise = Math.max(0, reservedCurrent - refund.amountPaise);
    order.confirmedRefundPaise = (order.confirmedRefundPaise || 0) + refund.amountPaise;

    const isDuplicateCompensation = refund.type === 'duplicate_charge_compensation';

    if (isDuplicateCompensation) {
      // Duplicate charge compensation: update duplicate bucket strictly
      order.duplicateRefundedPaise = (order.duplicateRefundedPaise || 0) + refund.amountPaise;
      // CRUCIAL: Duplicate compensation refunds NEVER transition order paymentStatus to 'refunded' or 'partially_refunded'
    } else {
      // Primary purchase refund (full or partial)
      order.purchaseRefundedPaise = (order.purchaseRefundedPaise || 0) + refund.amountPaise;

      const purchaseCaptured = order.purchaseCapturedPaise || order.amountPaise || Math.round(order.totalAmount * 100);

      if (order.purchaseRefundedPaise >= purchaseCaptured) {
        // Entire primary purchase is refunded
        order.paymentStatus = 'refunded';
        order.status = 'refunded';
      } else if (order.purchaseRefundedPaise > 0) {
        // Partial purchase refund: order status remains 'completed', paymentStatus is 'partially_refunded'
        order.paymentStatus = 'partially_refunded';
      }
    }

    if (eventId && !order.webhookEventsProcessed.includes(eventId)) {
      order.webhookEventsProcessed.push(eventId);
    }

    // Save Order and Refund with session to enforce Mongoose validators and hooks
    if (session) {
      await order.save({ session });
      await refund.save({ session });
    } else {
      await order.save();
      await refund.save();
    }

    // I. Transition Associated RefundJob to 'succeeded'
    if (refundJob) {
      refundJob.status = 'succeeded';
      if (!refundJob.providerRefundId) {
        refundJob.providerRefundId = refundId.trim();
      }
      refundJob.leaseWorkerId = null;
      refundJob.leaseToken = null;
      refundJob.leaseAcquiredAt = null;
      refundJob.leaseExpiresAt = null;

      if (session) {
        await refundJob.save({ session });
      } else {
        await refundJob.save();
      }
    }

    return {
      status: 'settled',
      refund,
      order,
      refundJob,
      duplicateDelivery: false,
    };
  });
}

// ============================================================================
// AUTHORITATIVE REFUND FAILURE HANDLING (refund.failed)
// ============================================================================

/**
 * Handles an authoritative refund failure (e.g. refund.failed webhook event).
 *
 * Requirements:
 * 1. Records failure reason and transitions Refund to 'failed'.
 * 2. Releases corresponding reserved amount (amountReservedRefundPaise) exactly once.
 * 3. Does NOT increment confirmedRefundPaise, purchaseRefundedPaise, or duplicateRefundedPaise.
 * 4. Stale/Duplicate guard: Already failed refunds do not release reservation twice.
 * 5. Settled guard: An already settled refund cannot be retroactively failed.
 * 6. Reverts paymentStatus from 'refund_pending' back to 'captured' (or 'partially_refunded' if prior partial refunds exist).
 * 7. Executes atomically in a MongoDB transaction.
 */
export async function processRefundFailure(
  params: ProcessRefundFailureParams
): Promise<ProcessRefundFailureResult> {
  const {
    refundId,
    paymentId,
    razorpayOrderId,
    failureReason = 'Gateway reported refund processing failed',
    eventId,
    notes,
    razorpayClient,
  } = params;

  if (!refundId || !refundId.trim()) {
    throw new RefundNotFoundError('A valid refund ID is required for failure processing.');
  }

  // 1. Authoritative Gateway Verification via Razorpay SDK if explicitly requested or client provided
  let gatewayRefund = params.gatewayRefund;
  if (!gatewayRefund && (params.fetchGatewayState || params.razorpayClient)) {
    gatewayRefund = await fetchAuthoritativeGatewayRefund(refundId, paymentId, razorpayClient);
  }

  return await withPaymentTransaction(async (session) => {
    // A. Locate the internal Refund record
    const refund = await locateRefundDocument({ refundId, paymentId, notes }, session);

    if (!refund) {
      throw new RefundNotFoundError(
        `No internal Refund record found matching refundId "${refundId}" for failure processing.`
      );
    }

    // B. Stale & Idempotency Checks
    if (refund.status === 'failed') {
      // Duplicate failure event: return idempotent success without double-releasing reservation
      const orderQuery = Order.findById(refund.orderId);
      if (session) orderQuery.session(session);
      const existingOrder = await orderQuery;

      if (!existingOrder) {
        throw new OrderNotFoundForRefundError(`Order ${refund.orderId} associated with failed refund not found.`);
      }

      let existingJob: IRefundJob | null = null;
      if (refund.refundJobId) {
        const jobQuery = RefundJob.findById(refund.refundJobId);
        if (session) jobQuery.session(session);
        existingJob = await jobQuery;
      }

      return {
        status: 'already_failed',
        refund,
        order: existingOrder,
        refundJob: existingJob,
        duplicateDelivery: true,
      };
    }

    if (refund.status === 'settled') {
      throw new StaleRefundEventError(
        `Stale event rejected: Refund ${refund.refundId} is already authoritatively settled. Cannot mark a settled refund as failed.`
      );
    }

    // C. Verify Associated Order
    const orderQuery = Order.findById(refund.orderId);
    if (session) orderQuery.session(session);
    const order = await orderQuery;

    if (!order) {
      throw new OrderNotFoundForRefundError(
        `Order ${refund.orderId} associated with Refund ${refund.refundId} was not found.`
      );
    }

    if (razorpayOrderId && order.razorpayOrderId && razorpayOrderId.trim() !== order.razorpayOrderId) {
      throw new RefundIdentityMismatchError(
        `Razorpay order ID mismatch: Event reports "${razorpayOrderId}", but Order ${order.orderId} has "${order.razorpayOrderId}".`
      );
    }

    // D. Associated RefundJob (if linked)
    let refundJob: IRefundJob | null = null;
    if (refund.refundJobId) {
      const jobQuery = RefundJob.findById(refund.refundJobId);
      if (session) jobQuery.session(session);
      refundJob = await jobQuery;
    }

    // E. Transition Refund to 'failed'
    refund.status = 'failed';
    refund.failureReason = failureReason;

    // F. Release Reserved Capacity on Order
    // Release the reserved amount exactly once without touching confirmed totals
    const reservedCurrent = order.amountReservedRefundPaise || 0;
    order.amountReservedRefundPaise = Math.max(0, reservedCurrent - refund.amountPaise);

    // Revert paymentStatus if it was 'refund_pending' and no other reservations are pending
    if (order.paymentStatus === 'refund_pending' && order.amountReservedRefundPaise === 0) {
      const purchaseCaptured = order.purchaseCapturedPaise || order.amountPaise || Math.round(order.totalAmount * 100);
      const purchaseRefunded = order.purchaseRefundedPaise || 0;

      if (purchaseRefunded >= purchaseCaptured && purchaseCaptured > 0) {
        order.paymentStatus = 'refunded';
      } else if (purchaseRefunded > 0) {
        order.paymentStatus = 'partially_refunded';
      } else {
        // Revert back to captured (or duplicate_charge_detected if duplicate funds captured)
        order.paymentStatus =
          (order.duplicateCapturedPaise || 0) > 0 ? 'duplicate_charge_detected' : 'captured';
      }
    }

    if (eventId && !order.webhookEventsProcessed.includes(eventId)) {
      order.webhookEventsProcessed.push(eventId);
    }

    // Save Order and Refund
    if (session) {
      await order.save({ session });
      await refund.save({ session });
    } else {
      await order.save();
      await refund.save();
    }

    // G. Transition RefundJob to 'manual_review'
    if (refundJob) {
      refundJob.status = 'manual_review';
      refundJob.manualReviewReason = `Gateway reported refund failure: ${failureReason}`;
      refundJob.lastError = failureReason;
      refundJob.errorHistory.push({
        error: `Gateway refund.failed: ${failureReason}`,
        timestamp: new Date(),
      });
      refundJob.leaseWorkerId = null;
      refundJob.leaseToken = null;
      refundJob.leaseAcquiredAt = null;
      refundJob.leaseExpiresAt = null;

      if (session) {
        await refundJob.save({ session });
      } else {
        await refundJob.save();
      }
    }

    return {
      status: 'failed_recorded',
      refund,
      order,
      refundJob,
      duplicateDelivery: false,
    };
  });
}
