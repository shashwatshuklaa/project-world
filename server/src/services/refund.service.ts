import crypto from 'crypto';
import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order.js';
import { PaymentAttempt, IPaymentAttempt } from '../models/PaymentAttempt.js';
import { Refund, IRefund, RefundType } from '../models/Refund.js';
import {
  RefundJob,
  IRefundJob,
  RefundJobClassification,
} from '../models/RefundJob.js';
import { withPaymentTransaction } from './capture.service.js';

// ============================================================================
// CUSTOM ERROR CLASSES FOR REFUND RESERVATION & ACCOUNTING
// ============================================================================

export class PaymentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotFoundError';
  }
}

export class PaymentNotCapturedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotCapturedError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}

export class OrderStateInvalidForRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderStateInvalidForRefundError';
  }
}

export class SecurityDiscrepancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityDiscrepancyError';
  }
}

export class InvalidRefundAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRefundAmountError';
  }
}

export class InvalidCurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCurrencyError';
  }
}

export class InvalidIdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyKeyError';
  }
}

export class RefundAmountExceedsRemainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundAmountExceedsRemainingError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ReserveRefundParams {
  orderId: string; // Internal Order UUID receipt or MongoDB ObjectId string
  paymentId: string; // Exact Razorpay payment ID (pay_xxx)
  amountPaise: number; // Integer paise strictly > 0
  currency?: string; // Strictly 'INR', defaults to 'INR'
  reason: string; // Business or operational reason
  idempotencyKey: string; // Deterministic stable idempotency key
  type?: RefundType; // Optional explicit classification
  notes?: string; // Optional operational notes
  refundId?: string; // Optional caller-provided refund ID (e.g. for testing)
}

export interface ReserveRefundResult {
  order: IOrder;
  paymentAttempt: IPaymentAttempt;
  refund: IRefund;
  refundJob: IRefundJob;
  isDuplicateReservation: boolean;
  status: 'reserved' | 'already_reserved';
  remainingPaymentRefundablePaise: number;
  remainingOrderRefundablePaise: number;
  remainingPurchaseRefundablePaise?: number;
  remainingDuplicateRefundablePaise?: number;
}

export interface RemainingRefundableCapacity {
  orderTotalCapturedPaise: number;
  orderReservedRefundPaise: number;
  orderConfirmedRefundPaise: number;
  orderRemainingRefundablePaise: number;
  orderPurchaseCapturedPaise: number;
  orderDuplicateCapturedPaise: number;
  orderPurchaseRemainingPaise: number;
  orderDuplicateRemainingPaise: number;
  paymentCapturedPaise?: number;
  paymentAllocatedPaise?: number;
  paymentRemainingRefundablePaise?: number;
}

// ============================================================================
// HELPER: DUPLICATE-KEY (E11000) ERROR DETECTION
// ============================================================================

export function isDuplicateKeyError(err: any): boolean {
  if (!err) return false;
  return (
    err.code === 11000 ||
    err.code === 11001 ||
    err.codeName === 'DuplicateKey' ||
    (typeof err.message === 'string' &&
      (err.message.includes('E11000') || err.message.includes('duplicate key')))
  );
}

// ============================================================================
// HELPER: DETERMINISTIC RESERVATION ID GENERATION
// ============================================================================

/**
 * Generates a stable, deterministic reservation refund ID prefixed with `rfnd_res_`
 * derived from the idempotency key using SHA-256 truncation.
 */
export function generateRefundReservationId(idempotencyKey: string): string {
  const hash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
  return `rfnd_res_${hash.substring(0, 20)}`;
}

// ============================================================================
// HELPER: CALCULATE REMAINING REFUNDABLE CAPACITY
// ============================================================================

/**
 * Queries and calculates the remaining refundable capacity for an order and
 * optionally a specific payment attempt, partitioning primary purchase funds
 * from duplicate charge compensation funds.
 */
export async function getRemainingRefundableCapacity(params: {
  orderId: string;
  paymentId?: string;
  session?: mongoose.ClientSession | null;
}): Promise<RemainingRefundableCapacity> {
  const { orderId, paymentId, session } = params;

  let orderDoc: IOrder | null = null;
  if (mongoose.Types.ObjectId.isValid(orderId)) {
    const query = Order.findById(orderId);
    if (session) query.session(session);
    orderDoc = await query;
  }
  if (!orderDoc) {
    const query = Order.findOne({ orderId });
    if (session) query.session(session);
    orderDoc = await query;
  }

  if (!orderDoc) {
    throw new OrderNotFoundError(`Order with identifier ${orderId} was not found.`);
  }

  const orderTotalCaptured = orderDoc.totalCapturedPaise || 0;
  const orderReserved = orderDoc.amountReservedRefundPaise || 0;
  const orderConfirmed = orderDoc.confirmedRefundPaise || 0;
  const orderRemaining = Math.max(0, orderTotalCaptured - (orderReserved + orderConfirmed));

  // Partitioned reservations
  const orderRefundsQuery = Refund.find({
    orderId: orderDoc._id,
    status: { $in: ['pending', 'settled'] },
  });
  if (session) orderRefundsQuery.session(session);
  const existingOrderRefunds = await orderRefundsQuery;

  let reservedPurchasePaise = 0;
  let reservedDuplicatePaise = 0;

  for (const r of existingOrderRefunds) {
    if (r.status === 'pending') {
      if (r.type === 'duplicate_charge_compensation') {
        reservedDuplicatePaise += r.amountPaise;
      } else {
        reservedPurchasePaise += r.amountPaise;
      }
    }
  }

  const orderPurchaseCaptured = orderDoc.purchaseCapturedPaise || 0;
  const orderDuplicateCaptured = orderDoc.duplicateCapturedPaise || 0;
  const orderPurchaseRefunded = orderDoc.purchaseRefundedPaise || 0;
  const orderDuplicateRefunded = orderDoc.duplicateRefundedPaise || 0;

  const orderPurchaseRemaining = Math.max(
    0,
    orderPurchaseCaptured - (orderPurchaseRefunded + reservedPurchasePaise)
  );
  const orderDuplicateRemaining = Math.max(
    0,
    orderDuplicateCaptured - (orderDuplicateRefunded + reservedDuplicatePaise)
  );

  const result: RemainingRefundableCapacity = {
    orderTotalCapturedPaise: orderTotalCaptured,
    orderReservedRefundPaise: orderReserved,
    orderConfirmedRefundPaise: orderConfirmed,
    orderRemainingRefundablePaise: orderRemaining,
    orderPurchaseCapturedPaise: orderPurchaseCaptured,
    orderDuplicateCapturedPaise: orderDuplicateCaptured,
    orderPurchaseRemainingPaise: orderPurchaseRemaining,
    orderDuplicateRemainingPaise: orderDuplicateRemaining,
  };

  if (paymentId) {
    const attemptQuery = PaymentAttempt.findOne({ paymentId });
    if (session) attemptQuery.session(session);
    const attempt = await attemptQuery;

    if (attempt) {
      const refundQuery = Refund.find({
        paymentId,
        status: { $in: ['pending', 'settled'] },
      });
      if (session) refundQuery.session(session);
      const paymentRefunds = await refundQuery;

      const allocatedPaise = paymentRefunds.reduce((sum, r) => sum + r.amountPaise, 0);
      result.paymentCapturedPaise = attempt.amountCapturedPaise;
      result.paymentAllocatedPaise = allocatedPaise;
      result.paymentRemainingRefundablePaise = Math.max(
        0,
        attempt.amountCapturedPaise - allocatedPaise
      );
    }
  }

  return result;
}

// ============================================================================
// HELPER: CONCURRENT IDEMPOTENCY KEY RECOVERY OUTSIDE TRANSACTION
// ============================================================================

const MAX_IDEMPOTENCY_RECOVERY_ATTEMPTS = 3;

/**
 * Recovers outside an aborted transaction when an E11000 duplicate-key collision occurs
 * on RefundJob.idempotencyKey or Refund.refundId.
 *
 * Re-reads the committed state, verifies parameter matching, and returns the existing
 * reservation without incrementing accounting twice.
 */
async function handleIdempotencyKeyRecovery(
  params: ReserveRefundParams,
  normalizedCurrency: string,
  originalError: any
): Promise<ReserveRefundResult> {
  const { orderId, paymentId, amountPaise, idempotencyKey } = params;

  for (let attemptNumber = 1; attemptNumber <= MAX_IDEMPOTENCY_RECOVERY_ATTEMPTS; attemptNumber++) {
    // Re-read committed RefundJob outside the failed transaction session
    const existingJob = await RefundJob.findOne({ idempotencyKey: idempotencyKey.trim() });

    if (existingJob) {
      // Find associated order to verify matching order
      let existingOrder: IOrder | null = null;
      if (mongoose.Types.ObjectId.isValid(orderId)) {
        existingOrder = await Order.findById(orderId);
      }
      if (!existingOrder) {
        existingOrder = await Order.findOne({ orderId: orderId.trim() });
      }

      const paymentMatches = existingJob.targetPaymentId === paymentId.trim();
      const amountMatches = existingJob.targetAmountPaise === amountPaise;
      const currencyMatches = existingJob.currency === normalizedCurrency;
      const orderMatches =
        existingOrder && existingJob.orderId.toString() === existingOrder._id.toString();

      if (!paymentMatches || !amountMatches || !currencyMatches || !orderMatches) {
        throw new IdempotencyConflictError(
          `Idempotency key "${idempotencyKey}" already exists with different refund parameters. ` +
            `Existing: payment=${existingJob.targetPaymentId}, amount=${existingJob.targetAmountPaise}, currency=${existingJob.currency}. ` +
            `Requested: payment=${paymentId}, amount=${amountPaise}, currency=${normalizedCurrency}.`
        );
      }

      // Fetch corresponding Refund record
      const existingRefund = await Refund.findOne({ refundJobId: existingJob._id });
      // Fetch payment attempt
      const existingAttempt = await PaymentAttempt.findOne({ paymentId: paymentId.trim() });

      const orderTotalCaptured = existingOrder ? existingOrder.totalCapturedPaise || 0 : 0;
      const orderReserved = existingOrder ? existingOrder.amountReservedRefundPaise || 0 : 0;
      const orderConfirmed = existingOrder ? existingOrder.confirmedRefundPaise || 0 : 0;
      const orderRemaining = Math.max(0, orderTotalCaptured - (orderReserved + orderConfirmed));

      return {
        order: existingOrder!,
        paymentAttempt: existingAttempt!,
        refund: existingRefund!,
        refundJob: existingJob,
        isDuplicateReservation: true,
        status: 'already_reserved',
        remainingPaymentRefundablePaise: existingAttempt
          ? Math.max(0, existingAttempt.amountCapturedPaise - amountPaise)
          : 0,
        remainingOrderRefundablePaise: orderRemaining,
      };
    }

    if (attemptNumber < MAX_IDEMPOTENCY_RECOVERY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 25 * attemptNumber));
    }
  }

  // If after bounded retries no committed job is found, re-throw the original error
  throw originalError;
}

// ============================================================================
// INTERNAL TRANSACTION FUNCTION
// ============================================================================

async function executeRefundReservationTransaction(
  params: ReserveRefundParams,
  session: mongoose.ClientSession | null,
  normalizedCurrency: string
): Promise<ReserveRefundResult> {
  const {
    orderId,
    paymentId,
    amountPaise,
    reason,
    idempotencyKey,
    type,
    notes,
    refundId: customRefundId,
  } = params;

  // 1. Idempotency Check: Inspect if a RefundJob already exists for this idempotency key
  const jobQuery = RefundJob.findOne({ idempotencyKey: idempotencyKey.trim() });
  if (session) jobQuery.session(session);
  const existingJob = await jobQuery;

  if (existingJob) {
    // Validate that all immutable business parameters match the existing job
    const paymentMatches = existingJob.targetPaymentId === paymentId.trim();
    const amountMatches = existingJob.targetAmountPaise === amountPaise;
    const currencyMatches = existingJob.currency === normalizedCurrency;

    // Find the associated order to verify order matching
    let existingOrder: IOrder | null = null;
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      const oQuery = Order.findById(orderId);
      if (session) oQuery.session(session);
      existingOrder = await oQuery;
    }
    if (!existingOrder) {
      const oQuery = Order.findOne({ orderId: orderId.trim() });
      if (session) oQuery.session(session);
      existingOrder = await oQuery;
    }

    const orderMatches =
      existingOrder && existingJob.orderId.toString() === existingOrder._id.toString();

    if (!paymentMatches || !amountMatches || !currencyMatches || !orderMatches) {
      throw new IdempotencyConflictError(
        `Idempotency key "${idempotencyKey}" already exists with different refund parameters. ` +
          `Existing: payment=${existingJob.targetPaymentId}, amount=${existingJob.targetAmountPaise}, currency=${existingJob.currency}. ` +
          `Requested: payment=${paymentId}, amount=${amountPaise}, currency=${normalizedCurrency}.`
      );
    }

    // Fetch corresponding Refund record
    const rQuery = Refund.findOne({ refundJobId: existingJob._id });
    if (session) rQuery.session(session);
    const existingRefund = await rQuery;

    // Fetch payment attempt
    const pQuery = PaymentAttempt.findOne({ paymentId: paymentId.trim() });
    if (session) pQuery.session(session);
    const existingAttempt = await pQuery;

    const orderTotalCaptured = existingOrder ? existingOrder.totalCapturedPaise || 0 : 0;
    const orderReserved = existingOrder ? existingOrder.amountReservedRefundPaise || 0 : 0;
    const orderConfirmed = existingOrder ? existingOrder.confirmedRefundPaise || 0 : 0;
    const orderRemaining = Math.max(0, orderTotalCaptured - (orderReserved + orderConfirmed));

    return {
      order: existingOrder!,
      paymentAttempt: existingAttempt!,
      refund: existingRefund!,
      refundJob: existingJob,
      isDuplicateReservation: true,
      status: 'already_reserved',
      remainingPaymentRefundablePaise: existingAttempt
        ? Math.max(0, existingAttempt.amountCapturedPaise - amountPaise)
        : 0,
      remainingOrderRefundablePaise: orderRemaining,
    };
  }

  // 2. Locate Order Document
  let order: IOrder | null = null;
  if (mongoose.Types.ObjectId.isValid(orderId)) {
    const oQuery = Order.findById(orderId);
    if (session) oQuery.session(session);
    order = await oQuery;
  }
  if (!order) {
    const oQuery = Order.findOne({ orderId: orderId.trim() });
    if (session) oQuery.session(session);
    order = await oQuery;
  }

  if (!order) {
    throw new OrderNotFoundError(`Order with identifier "${orderId}" was not found.`);
  }

  // 3. Locate PaymentAttempt Document
  const attemptQuery = PaymentAttempt.findOne({ paymentId: paymentId.trim() });
  if (session) attemptQuery.session(session);
  const attempt = await attemptQuery;

  if (!attempt) {
    throw new PaymentNotFoundError(
      `Payment attempt with ID "${paymentId}" was not found.`
    );
  }

  // 4. Validate Payment Attempt Order Association
  if (attempt.orderId.toString() !== order._id.toString()) {
    throw new SecurityDiscrepancyError(
      `Payment association mismatch: Payment ${paymentId} belongs to Order ${attempt.orderId}, ` +
        `but refund reservation was requested for Order ${order._id} (${order.orderId}).`
    );
  }

  // 5. Validate Payment Status: Only Captured Payments Can Be Refunded
  if (attempt.status !== 'captured') {
    throw new PaymentNotCapturedError(
      `Payment ${paymentId} cannot be refunded because its status is "${attempt.status}". ` +
        `Only successfully captured payments can be refunded.`
    );
  }

  // 6. Validate Order Financial State
  if (!order.totalCapturedPaise || order.totalCapturedPaise <= 0) {
    throw new OrderStateInvalidForRefundError(
      `Order ${order.orderId} has no captured funds (totalCapturedPaise = ${order.totalCapturedPaise || 0}). ` +
        `Refund reservation rejected.`
    );
  }

  // 7. Calculate Existing Allocations for this Specific PaymentAttempt
  const refundQuery = Refund.find({
    paymentId: paymentId.trim(),
    status: { $in: ['pending', 'settled'] },
  });
  if (session) refundQuery.session(session);
  const existingPaymentRefunds = await refundQuery;

  const allocatedPaymentPaise = existingPaymentRefunds.reduce(
    (sum, r) => sum + r.amountPaise,
    0
  );
  const remainingPaymentPaise = attempt.amountCapturedPaise - allocatedPaymentPaise;

  if (amountPaise > remainingPaymentPaise) {
    throw new RefundAmountExceedsRemainingError(
      `Requested refund amount of ${amountPaise} paise exceeds remaining refundable capacity of ` +
        `${remainingPaymentPaise} paise for payment ${paymentId} ` +
        `(captured: ${attempt.amountCapturedPaise} paise, already allocated: ${allocatedPaymentPaise} paise).`
    );
  }

  // 8. Determine Refund Classification & Type
  let refundClassification: RefundJobClassification;
  let refundType: RefundType;

  if (type) {
    refundType = type;
    if (
      type === 'purchase_compensation' ||
      type === 'duplicate_charge_compensation' ||
      type === 'partial_refund'
    ) {
      refundClassification = type;
    } else {
      refundClassification = 'other';
    }
  } else if (attempt.classification === 'duplicate_charge') {
    refundClassification = 'duplicate_charge_compensation';
    refundType = 'duplicate_charge_compensation';
  } else if (amountPaise === attempt.amountCapturedPaise && allocatedPaymentPaise === 0) {
    refundClassification = 'purchase_compensation';
    refundType = 'purchase_compensation';
  } else {
    refundClassification = 'partial_refund';
    refundType = 'partial_refund';
  }

  // 9. Separate Dual-Ledger Accounting Invariants
  const isDuplicateRefund =
    refundClassification === 'duplicate_charge_compensation' ||
    attempt.classification === 'duplicate_charge';

  // Query all existing refunds for this order to compute partitioned reservations
  const existingOrderRefundsQuery = Refund.find({
    orderId: order._id,
    status: { $in: ['pending', 'settled'] },
  });
  if (session) existingOrderRefundsQuery.session(session);
  const existingOrderRefunds = await existingOrderRefundsQuery;

  let reservedPurchasePaise = 0;
  let reservedDuplicatePaise = 0;

  for (const r of existingOrderRefunds) {
    if (r.status === 'pending') {
      if (r.type === 'duplicate_charge_compensation') {
        reservedDuplicatePaise += r.amountPaise;
      } else {
        reservedPurchasePaise += r.amountPaise;
      }
    }
  }

  const orderPurchaseCaptured = order.purchaseCapturedPaise || 0;
  const orderDuplicateCaptured = order.duplicateCapturedPaise || 0;
  const orderPurchaseRefunded = order.purchaseRefundedPaise || 0;
  const orderDuplicateRefunded = order.duplicateRefundedPaise || 0;

  const remainingPurchasePaise = Math.max(
    0,
    orderPurchaseCaptured - (orderPurchaseRefunded + reservedPurchasePaise)
  );
  const remainingDuplicatePaise = Math.max(
    0,
    orderDuplicateCaptured - (orderDuplicateRefunded + reservedDuplicatePaise)
  );

  if (isDuplicateRefund) {
    // Duplicate compensation refunds must be strictly bounded by duplicate captured capacity
    if (amountPaise > remainingDuplicatePaise) {
      throw new RefundAmountExceedsRemainingError(
        `Requested duplicate compensation refund amount of ${amountPaise} paise exceeds remaining duplicate refundable capacity of ` +
          `${remainingDuplicatePaise} paise for order ${order.orderId} ` +
          `(duplicate captured: ${orderDuplicateCaptured} paise, duplicate settled: ${orderDuplicateRefunded} paise, duplicate reserved: ${reservedDuplicatePaise} paise). ` +
          `Duplicate refunds cannot consume primary purchase capacity.`
      );
    }
  } else {
    // Primary purchase refunds must be strictly bounded by primary purchase captured capacity
    if (amountPaise > remainingPurchasePaise) {
      throw new RefundAmountExceedsRemainingError(
        `Requested purchase refund amount of ${amountPaise} paise exceeds remaining purchase refundable capacity of ` +
          `${remainingPurchasePaise} paise for order ${order.orderId} ` +
          `(purchase captured: ${orderPurchaseCaptured} paise, purchase settled: ${orderPurchaseRefunded} paise, purchase reserved: ${reservedPurchasePaise} paise). ` +
          `Purchase refunds cannot consume duplicate captured funds.`
      );
    }
  }

  // Also verify against global order ceiling
  const orderTotalCaptured = order.totalCapturedPaise || 0;
  const orderReserved = order.amountReservedRefundPaise || 0;
  const orderConfirmed = order.confirmedRefundPaise || 0;
  const remainingOrderPaise = orderTotalCaptured - (orderReserved + orderConfirmed);

  if (amountPaise > remainingOrderPaise) {
    throw new RefundAmountExceedsRemainingError(
      `Requested refund amount of ${amountPaise} paise exceeds total remaining refundable capacity of ` +
        `${remainingOrderPaise} paise for order ${order.orderId}.`
    );
  }

  // 10. Atomically Update Order Reservation Accounting
  const previousReserved = order.amountReservedRefundPaise || 0;
  const previousPaymentStatus = order.paymentStatus;

  order.amountReservedRefundPaise += amountPaise;

  // Crucial Guard: Only transition paymentStatus to 'refund_pending' for PRIMARY purchase refunds.
  // Duplicate-charge compensation refunds must NEVER change the primary order's paymentStatus
  // to 'refund_pending' or 'refunded'.
  if (!isDuplicateRefund) {
    if (order.paymentStatus === 'captured' || order.paymentStatus === 'duplicate_charge_detected') {
      order.paymentStatus = 'refund_pending';
    }
  }

  try {
    // Save order document to enforce all Mongoose schema validators and pre-save immutability hooks
    if (session) {
      await order.save({ session });
    } else {
      await order.save();
    }

    // 11. Create RefundJob Record Atomically
    const jobCreationData = {
      orderId: order._id,
      targetPaymentId: paymentId.trim(),
      targetAmountPaise: amountPaise,
      currency: normalizedCurrency,
      reason: reason.trim(),
      classification: refundClassification,
      idempotencyKey: idempotencyKey.trim(),
      status: 'pending' as const,
      apiDispatched: false,
      attempts: 0,
    };

    let refundJob: IRefundJob;
    if (session) {
      const [createdJob] = await RefundJob.create([jobCreationData], { session });
      refundJob = createdJob;
    } else {
      refundJob = await RefundJob.create(jobCreationData);
    }

    // 12. Create Refund Record Atomically
    const refundId = customRefundId?.trim() || generateRefundReservationId(idempotencyKey.trim());
    const refundCreationData = {
      refundId,
      orderId: order._id,
      paymentId: paymentId.trim(),
      refundJobId: refundJob._id,
      amountPaise,
      currency: normalizedCurrency,
      type: refundType,
      status: 'pending' as const,
      notes: notes?.trim(),
    };

    let refund: IRefund;
    if (session) {
      const [createdRefund] = await Refund.create([refundCreationData], { session });
      refund = createdRefund;
    } else {
      refund = await Refund.create(refundCreationData);
    }

    // 13. Return Success Result
    const newRemainingPayment = remainingPaymentPaise - amountPaise;
    const newRemainingOrder = remainingOrderPaise - amountPaise;
    const newRemainingPurchase = isDuplicateRefund
      ? remainingPurchasePaise
      : remainingPurchasePaise - amountPaise;
    const newRemainingDuplicate = isDuplicateRefund
      ? remainingDuplicatePaise - amountPaise
      : remainingDuplicatePaise;

    return {
      order,
      paymentAttempt: attempt,
      refund,
      refundJob,
      isDuplicateReservation: false,
      status: 'reserved',
      remainingPaymentRefundablePaise: newRemainingPayment,
      remainingOrderRefundablePaise: newRemainingOrder,
      remainingPurchaseRefundablePaise: newRemainingPurchase,
      remainingDuplicateRefundablePaise: newRemainingDuplicate,
    };
  } catch (err) {
    // In disconnected / test environment without live replica set rollback engine,
    // revert in-memory mutations on the document instance to preserve consistency
    if (!session) {
      order.amountReservedRefundPaise = previousReserved;
      order.paymentStatus = previousPaymentStatus;
    }
    throw err;
  }
}

// ============================================================================
// CORE SERVICE: RESERVE REFUND
// ============================================================================

/**
 * Atomically reserves a full or partial refund against a successfully captured payment.
 *
 * Guarantees:
 * 1. Only captured payments can be refunded.
 * 2. Refund amounts are verified strictly as positive integer paise in currency INR.
 * 3. Requested refund amount cannot exceed remaining refundable capacity on the payment attempt OR the order.
 * 4. Concurrent reservations cannot over-reserve captured funds (enforced via MongoDB transaction write-locks & retries).
 * 5. Uses stable idempotency keys: duplicate submissions return idempotent success without duplicate records.
 * 6. Under concurrent idempotency races, E11000 duplicate-key collisions recover cleanly outside the transaction.
 * 7. Duplicate-charge compensation reservations are strictly partitioned and cannot consume primary purchase capacity,
 *    nor can they change the primary order's paymentStatus to 'refund_pending' or 'refunded'.
 * 8. Creates corresponding Refund and RefundJob records atomically in the same transaction session.
 * 9. Maintains dual-ledger accounting: increments `order.amountReservedRefundPaise` without modifying settled totals.
 * 10. Preserves immutable model-field protections via Mongoose document save() and create().
 */
export async function reserveRefund(params: ReserveRefundParams): Promise<ReserveRefundResult> {
  const {
    orderId,
    paymentId,
    amountPaise,
    currency = 'INR',
    reason,
    idempotencyKey,
  } = params;

  // --------------------------------------------------------------------------
  // 1. INPUT VALIDATION
  // --------------------------------------------------------------------------
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new InvalidIdempotencyKeyError('Idempotency key is required and must be a non-empty string.');
  }

  if (!paymentId || typeof paymentId !== 'string' || paymentId.trim().length === 0) {
    throw new Error('Payment ID is required.');
  }

  if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
    throw new Error('Order ID is required.');
  }

  if (
    typeof amountPaise !== 'number' ||
    !Number.isInteger(amountPaise) ||
    amountPaise <= 0
  ) {
    throw new InvalidRefundAmountError(
      `Refund amount must be a positive integer number of paise. Received: ${amountPaise}`
    );
  }

  const normalizedCurrency = (currency || 'INR').trim().toUpperCase();
  if (normalizedCurrency !== 'INR') {
    throw new InvalidCurrencyError(
      `Currency ${currency} is not supported. This application strictly requires currency INR.`
    );
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('Refund reason is required and cannot be empty.');
  }

  // --------------------------------------------------------------------------
  // 2. ATOMIC TRANSACTION EXECUTION & E11000 RECOVERY
  // --------------------------------------------------------------------------
  try {
    return await withPaymentTransaction(async (session) => {
      return await executeRefundReservationTransaction(params, session, normalizedCurrency);
    });
  } catch (err: any) {
    if (isDuplicateKeyError(err)) {
      return await handleIdempotencyKeyRecovery(params, normalizedCurrency, err);
    }
    throw err;
  }
}
