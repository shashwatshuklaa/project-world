import mongoose from 'mongoose';
import { Order, IOrder } from '../models/Order.js';
import {
  PaymentAttempt,
  IPaymentAttempt,
  PaymentAttemptClassification,
} from '../models/PaymentAttempt.js';
import { getRazorpayClient } from '../config/razorpay.js';
import { reconcileCartAfterPayment } from './payment.service.js';

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

export class PaymentNotCapturedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentNotCapturedError';
  }
}

export class GatewayOrderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayOrderMismatchError';
  }
}

export class GatewayAmountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayAmountMismatchError';
  }
}

export class GatewayCurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayCurrencyMismatchError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}

export class SecurityDiscrepancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityDiscrepancyError';
  }
}

export class TransactionSupportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionSupportError';
  }
}

export class MissingCanonicalAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingCanonicalAmountError';
  }
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ProcessPaymentCaptureParams {
  paymentId: string;
  orderId?: string; // Internal order identifier, if known
  razorpayOrderId: string; // Gateway order ID (order_xxx)
  amountPaise?: number; // Exact payment amount in integer paise, if known
  currency?: string; // Strictly 'INR'
  gatewayMethod?: string; // Card, UPI, netbanking, etc.
  eventId?: string; // Razorpay event ID if arriving via webhook
  signature?: string; // Frontend signature if arriving via checkout callback
  source: 'callback' | 'webhook';
  verifiedGatewayPayment?: any; // Pre-fetched gateway entity if available
}

export interface CaptureProcessingResult {
  order: IOrder;
  attempt: IPaymentAttempt;
  duplicateDelivery: boolean;
  classification: PaymentAttemptClassification;
  wasLateCapture: boolean;
}

// ============================================================================
// HELPER: TRANSACTION SUPPORT DETECTION & RETRY
// ============================================================================

export function isTransactionUnsupportedError(err: any): boolean {
  if (!err) return false;
  const msg = err.message || '';
  return (
    err.code === 20 ||
    err.codeName === 'IllegalOperation' ||
    msg.includes('Transaction numbers are only allowed on a replica set member or mongos') ||
    msg.includes('Transactions are not supported') ||
    msg.includes('standalone')
  );
}

export function isTransientTransactionError(err: any): boolean {
  if (!err) return false;
  if (typeof err.hasErrorLabel === 'function') {
    if (
      err.hasErrorLabel('TransientTransactionError') ||
      err.hasErrorLabel('UnknownTransactionCommitResult')
    ) {
      return true;
    }
  }
  const msg = err.message || '';
  return (
    err.code === 112 || // WriteConflict in MongoDB
    err.codeName === 'WriteConflict' ||
    msg.includes('WriteConflict') ||
    msg.includes('TransientTransactionError') ||
    msg.includes('UnknownTransactionCommitResult') ||
    (Array.isArray(err.errorLabels) &&
      (err.errorLabels.includes('TransientTransactionError') ||
        err.errorLabels.includes('UnknownTransactionCommitResult')))
  );
}

const MAX_TRANSACTION_RETRIES = 3;
let transactionExecutionQueue: Promise<any> = Promise.resolve();

/**
 * Runs operations within a MongoDB transaction session if supported by deployment.
 * If transaction support is unavailable (e.g. standalone MongoDB instance), fails safely
 * by throwing TransactionSupportError rather than performing un-isolated writes.
 * Implements bounded retries for transient transaction errors and write conflicts.
 * Serializes local concurrent executions to prevent lost updates and WriteConflict aborts.
 */
export async function withPaymentTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>
): Promise<T> {
  const execute = async (): Promise<T> => {
    let lastError: any;

    for (let attemptNumber = 1; attemptNumber <= MAX_TRANSACTION_RETRIES; attemptNumber++) {
      // Check if live mongoose connection is open
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        let session: mongoose.ClientSession | null = null;
        try {
          session = await mongoose.startSession();
        } catch (err: any) {
          if (isTransactionUnsupportedError(err)) {
            throw new TransactionSupportError(
              'MongoDB deployment does not support replica set transactions. Operation aborted to prevent partial non-atomic state.'
            );
          }
          throw err;
        }

        try {
          let result!: T;
          await session.withTransaction(async () => {
            result = await fn(session);
          });
          return result;
        } catch (err: any) {
          lastError = err;
          if (isTransactionUnsupportedError(err)) {
            throw new TransactionSupportError(
              'MongoDB deployment does not support replica set transactions. Operation aborted to prevent partial non-atomic state.'
            );
          }
          if (isTransientTransactionError(err) && attemptNumber < MAX_TRANSACTION_RETRIES) {
            const backoffMs = Math.min(25 * Math.pow(2, attemptNumber - 1), 200);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          throw err;
        } finally {
          if (session) {
            await session.endSession();
          }
        }
      } else {
        // In disconnected or mock test environment, execute with bounded retry for transient errors
        try {
          return await fn(null);
        } catch (err: any) {
          lastError = err;
          if (isTransientTransactionError(err) && attemptNumber < MAX_TRANSACTION_RETRIES) {
            const backoffMs = Math.min(25 * Math.pow(2, attemptNumber - 1), 200);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          throw err;
        }
      }
    }

    throw lastError;
  };

  const nextExecution = transactionExecutionQueue.then(execute, execute);
  transactionExecutionQueue = nextExecution.then(
    () => {},
    () => {}
  );
  return nextExecution;
}

// ============================================================================
// AUTHORITATIVE GATEWAY PAYMENT VERIFICATION
// ============================================================================

/**
 * Fetches and verifies authoritative payment status and metadata from Razorpay server-side API.
 * Validates:
 * 1. Payment status is strictly 'captured'.
 * 2. Associated gateway order ID matches expected order ID.
 * 3. Exact amount in integer paise matches expected amount.
 * 4. Currency is strictly 'INR'.
 */
export async function fetchAndVerifyGatewayPayment(params: {
  paymentId: string;
  expectedOrderId?: string;
  expectedPaise?: number;
  expectedCurrency?: string;
  cachedEntity?: any;
}): Promise<any> {
  const { paymentId, expectedOrderId, expectedPaise, expectedCurrency = 'INR', cachedEntity } = params;

  if (!paymentId || typeof paymentId !== 'string') {
    throw new Error('Payment ID is required to fetch gateway payment.');
  }

  let payment = cachedEntity;

  // If no cached or pre-verified entity, fetch authoritatively from Razorpay SDK
  if (!payment) {
    const client = getRazorpayClient();
    if (!client || !client.payments || typeof client.payments.fetch !== 'function') {
      throw new Error('Razorpay client is not configured for payment fetching.');
    }
    try {
      payment = await client.payments.fetch(paymentId);
    } catch (err: any) {
      throw new Error(`Razorpay gateway lookup failed for payment ${paymentId}: ${err.message || err}`);
    }
  }

  if (!payment || payment.id !== paymentId) {
    throw new Error(`Gateway returned invalid payment entity for ${paymentId}`);
  }

  // 1. Captured status validation: never record uncaptured payments as captured
  const paymentStatus = payment.status ?? (payment.captured === true ? 'captured' : undefined);
  if (paymentStatus !== 'captured') {
    throw new PaymentNotCapturedError(
      `Payment ${paymentId} has status "${payment.status}", not "captured"`
    );
  }

  // 2. Gateway Order ID match
  if (expectedOrderId && payment.order_id && payment.order_id !== expectedOrderId) {
    throw new GatewayOrderMismatchError(
      `Gateway order ID mismatch: expected ${expectedOrderId}, received ${payment.order_id}`
    );
  }

  // 3. Exact amount in paise match
  if (expectedPaise !== undefined && payment.amount !== expectedPaise) {
    throw new GatewayAmountMismatchError(
      `Payment amount or currency mismatch: expected ${expectedPaise} paise, received ${payment.amount} paise`
    );
  }

  // 4. Currency match: strictly INR
  const gatewayCurrency = (payment.currency || '').toUpperCase();
  if (
    gatewayCurrency !== 'INR' ||
    (expectedCurrency && gatewayCurrency !== expectedCurrency.toUpperCase())
  ) {
    throw new GatewayCurrencyMismatchError(
      `Payment amount or currency mismatch: expected INR, received ${payment.currency}`
    );
  }

  return payment;
}

// ============================================================================
// HELPER: DUPLICATE KEY ERROR CLASSIFICATION
// ============================================================================

export function isDuplicateKeyError(err: any): boolean {
  if (!err) return false;
  return (
    err.code === 11000 ||
    err.codeName === 'DuplicateKey' ||
    (err.name === 'MongoServerError' && err.code === 11000) ||
    (typeof err.message === 'string' && err.message.includes('E11000'))
  );
}

export function isPrimaryUniqueIndexCollision(err: any): boolean {
  if (!isDuplicateKeyError(err)) return false;
  const msg = err.message || '';
  if (msg.includes('orderId_1_classification_1')) return true;
  if (err.keyPattern && err.keyPattern.orderId && err.keyPattern.classification) return true;
  return false;
}

// ============================================================================
// SINGLE CANONICAL PAYMENT CAPTURE PROCESSING TRANSACTION
// ============================================================================

/**
 * Executes a single atomic capture transaction inside withPaymentTransaction.
 * If a write operation (e.g. PaymentAttempt.create) fails with E11000, it does NOT
 * attempt to perform further writes within this aborted session. The transaction aborts
 * cleanly, and recovery is handled outside the failed transaction.
 */
async function executeCaptureTransaction(
  params: ProcessPaymentCaptureParams,
  forcedClassification?: PaymentAttemptClassification
): Promise<CaptureProcessingResult> {
  const {
    paymentId,
    orderId,
    razorpayOrderId,
    amountPaise,
    currency = 'INR',
    gatewayMethod,
    eventId,
    signature,
    source,
    verifiedGatewayPayment,
  } = params;

  // 1. Locate internal Order by razorpayOrderId, or fallback to internal orderId
  let order = await Order.findOne({ razorpayOrderId });
  if (!order && orderId) {
    order = await Order.findOne({ orderId });
  }

  if (!order) {
    throw new OrderNotFoundError(
      `No internal order found for razorpayOrderId: ${razorpayOrderId}${orderId ? ` or orderId: ${orderId}` : ''}`
    );
  }

  // 2. Authoritative Order Amount Validation
  // Fails safely if order lacks canonical integer amountPaise; does NOT silently fall back to totalAmount.
  if (
    order.amountPaise === undefined ||
    order.amountPaise === null ||
    typeof order.amountPaise !== 'number' ||
    !Number.isInteger(order.amountPaise) ||
    order.amountPaise <= 0
  ) {
    throw new MissingCanonicalAmountError(
      `Order ${order.orderId || order._id} is missing canonical integer amountPaise. Payment capture aborted to prevent unverified financial reconciliation.`
    );
  }
  const expectedPaise = order.amountPaise;

  // Verify that the order's stored razorpayOrderId matches the gateway orderId
  if (order.razorpayOrderId && order.razorpayOrderId !== razorpayOrderId) {
    throw new GatewayOrderMismatchError(
      `Order razorpayOrderId mismatch: stored ${order.razorpayOrderId}, incoming ${razorpayOrderId}`
    );
  }

  // 3. Authoritative Gateway Verification
  const gatewayPayment = await fetchAndVerifyGatewayPayment({
    paymentId,
    expectedOrderId: order.razorpayOrderId || razorpayOrderId,
    expectedPaise,
    expectedCurrency: order.currency || currency,
    cachedEntity: verifiedGatewayPayment,
  });

  // 4. Pre-transaction Idempotency & Security Check
  const existingAttempt = await PaymentAttempt.findOne({ paymentId });
  if (existingAttempt) {
    // SECURITY CHECK: A payment ID already associated with another order must NEVER be accepted
    if (existingAttempt.orderId.toString() !== order._id.toString()) {
      throw new SecurityDiscrepancyError(
        `Payment ID ${paymentId} is already associated with internal order ${existingAttempt.orderId}, cannot associate with ${order._id}`
      );
    }

    // Verify all relevant identity fields
    if (
      existingAttempt.paymentId !== paymentId ||
      (order.razorpayOrderId && existingAttempt.razorpayOrderId !== order.razorpayOrderId) ||
      existingAttempt.amountCapturedPaise !== gatewayPayment.amount ||
      existingAttempt.currency !== 'INR'
    ) {
      throw new SecurityDiscrepancyError(
        `Payment identity verification failed for ${paymentId}: stored attempt metadata does not match gateway payment.`
      );
    }

    // IDEMPOTENCY CHECK: If already captured for this exact order, duplicate delivery
    if (existingAttempt.status === 'captured') {
      if (eventId && !order.webhookEventsProcessed.includes(eventId)) {
        order.webhookEventsProcessed.push(eventId);
        await order.save();
      }
      return {
        order,
        attempt: existingAttempt,
        duplicateDelivery: true,
        classification: existingAttempt.classification,
        wasLateCapture: existingAttempt.classification === 'compensation',
      };
    }
  }

  // 5. Atomic Database Mutation inside Transaction
  return await withPaymentTransaction(async (session) => {
    // Reload Order within session for snapshot consistency
    const currentOrder = session
      ? await Order.findById(order._id).session(session)
      : await Order.findById(order._id);

    if (!currentOrder) {
      throw new OrderNotFoundError(`Order ${order._id} was deleted during processing`);
    }

    // Double-check attempt within session
    let attempt = session
      ? await PaymentAttempt.findOne({ paymentId }).session(session)
      : await PaymentAttempt.findOne({ paymentId });

    if (attempt) {
      if (attempt.orderId.toString() !== currentOrder._id.toString()) {
        throw new SecurityDiscrepancyError(
          `Payment ID ${paymentId} is already associated with internal order ${attempt.orderId}, cannot associate with ${currentOrder._id}`
        );
      }
      if (
        attempt.paymentId !== paymentId ||
        (currentOrder.razorpayOrderId && attempt.razorpayOrderId !== currentOrder.razorpayOrderId) ||
        attempt.amountCapturedPaise !== gatewayPayment.amount ||
        attempt.currency !== 'INR'
      ) {
        throw new SecurityDiscrepancyError(
          `Payment identity verification failed for ${paymentId}: stored attempt metadata does not match gateway payment.`
        );
      }

      if (attempt.status === 'captured') {
        return {
          order: currentOrder,
          attempt,
          duplicateDelivery: true,
          classification: attempt.classification,
          wasLateCapture: attempt.classification === 'compensation',
        };
      }
    }

    // Determine Classification:
    const isTerminalOrder =
      currentOrder.status === 'cancelled' || currentOrder.status === 'refunded';
    const hasExistingPrimary =
      Boolean(currentOrder.primaryPaymentId) && currentOrder.primaryPaymentId !== paymentId;

    let classification: PaymentAttemptClassification;
    let notes: string;

    if (forcedClassification) {
      classification = forcedClassification;
      notes = `Classification (${forcedClassification}) assigned following primary race resolution. Primary payment is ${currentOrder.primaryPaymentId}.`;
    } else if (isTerminalOrder) {
      // Late capture on cancelled or refunded order:
      // NEVER resurrect to completed or trigger fulfillment.
      classification = 'compensation';
      notes = `Late capture received on terminal order (${currentOrder.status}). Excess funds requiring compensation.`;
    } else if (hasExistingPrimary) {
      // Primary payment was already claimed by another payment ID:
      // This is a duplicate charge.
      classification = 'duplicate_charge';
      notes = `Duplicate charge: primary purchase payment is ${currentOrder.primaryPaymentId}.`;
    } else {
      // Primary purchase payment
      classification = 'primary';
      notes = `Primary purchase payment captured via ${source}.`;
    }

    // Create or update PaymentAttempt
    if (attempt) {
      attempt.status = 'captured';
      attempt.amountCapturedPaise = gatewayPayment.amount;
      attempt.currency = 'INR';
      attempt.classification = classification;
      attempt.gatewayMethod = gatewayPayment.method || gatewayMethod;
      attempt.notes = notes;
      await (session ? attempt.save({ session }) : attempt.save());
    } else {
      // NOTE: In MongoDB transactions, a duplicate key error (E11000) aborts the transaction.
      // We do NOT attempt further writes within this aborted session.
      // We allow E11000 to bubble up so withPaymentTransaction aborts cleanly, and
      // recovery executes outside the aborted transaction.
      const createPayload = {
        paymentId,
        orderId: currentOrder._id,
        razorpayOrderId: currentOrder.razorpayOrderId || razorpayOrderId,
        amountCapturedPaise: gatewayPayment.amount,
        currency: 'INR',
        status: 'captured' as const,
        classification,
        gatewayMethod: gatewayPayment.method || gatewayMethod,
        notes,
      };

      if (session) {
        const docs = await PaymentAttempt.create([createPayload], { session });
        attempt = docs[0];
      } else {
        attempt = await PaymentAttempt.create(createPayload);
      }
    }

    // Apply financial accounting to Order
    const capturedAmount = gatewayPayment.amount;

    if (classification === 'primary') {
      currentOrder.primaryPaymentId = paymentId;
      currentOrder.razorpayPaymentId = paymentId;
      currentOrder.purchaseCapturedPaise += capturedAmount;
      currentOrder.totalCapturedPaise += capturedAmount;
      currentOrder.status = 'completed';
      currentOrder.paymentStatus = 'captured';
      currentOrder.paidAt = currentOrder.paidAt || new Date();
      if (signature && !currentOrder.razorpaySignature) {
        currentOrder.razorpaySignature = signature;
      }
      if (gatewayPayment.method && !currentOrder.paymentMethod) {
        currentOrder.paymentMethod = gatewayPayment.method;
      }
    } else if (classification === 'duplicate_charge') {
      currentOrder.totalCapturedPaise += capturedAmount;
      currentOrder.duplicateCapturedPaise += capturedAmount;
      currentOrder.paymentStatus = 'duplicate_charge_detected';
      // Do NOT overwrite primaryPaymentId, purchaseCapturedPaise, or order.status
    } else if (classification === 'compensation') {
      currentOrder.totalCapturedPaise += capturedAmount;
      currentOrder.duplicateCapturedPaise += capturedAmount;
      currentOrder.paymentStatus = 'duplicate_charge_detected';
      // Order status strictly remains 'cancelled' or 'refunded'
    }

    if (eventId && !currentOrder.webhookEventsProcessed.includes(eventId)) {
      currentOrder.webhookEventsProcessed.push(eventId);
    }

    // Financial invariant assertion:
    // totalCapturedPaise MUST equal purchaseCapturedPaise + duplicateCapturedPaise
    const invariantTotal =
      currentOrder.purchaseCapturedPaise + currentOrder.duplicateCapturedPaise;
    if (currentOrder.totalCapturedPaise !== invariantTotal) {
      throw new Error(
        `Financial invariant failure: totalCapturedPaise (${currentOrder.totalCapturedPaise}) !== purchaseCapturedPaise (${currentOrder.purchaseCapturedPaise}) + duplicateCapturedPaise (${currentOrder.duplicateCapturedPaise})`
      );
    }

    // Cart reconciliation: deduct purchased snapshot quantities only if primary capture
    if (classification === 'primary' && !currentOrder.cartReconciled) {
      await reconcileCartAfterPayment(currentOrder);
      currentOrder.cartReconciled = true;
    }

    await (session ? currentOrder.save({ session }) : currentOrder.save());

    return {
      order: currentOrder,
      attempt: attempt!,
      duplicateDelivery: false,
      classification,
      wasLateCapture: isTerminalOrder,
    };
  });
}

// ============================================================================
// E11000 RECOVERY HANDLER OUTSIDE THE FAILED TRANSACTION
// ============================================================================

/**
 * Handles E11000 recovery outside the aborted transaction:
 * 1. Confirms the failed transaction was aborted.
 * 2. Re-reads the committed winning PaymentAttempt and Order outside the failed transaction.
 * 3. Verifies payment identity and order association.
 * 4. If this is a different valid payment for the same order, retries its classification
 *    and accounting in a FRESH transaction as duplicate_charge.
 * 5. Never treats a cross-order payment as successful.
 * 6. Keeps recovery bounded and idempotent.
 */
async function handleDuplicateKeyRecovery(
  params: ProcessPaymentCaptureParams,
  err: any,
  initialOrder: IOrder,
  gatewayPayment: any
): Promise<CaptureProcessingResult> {
  const { paymentId, eventId } = params;

  // 1. Check if an attempt for this exact paymentId already exists (Duplicate Delivery Race on paymentId_1)
  const existingAttempt = await PaymentAttempt.findOne({ paymentId });

  if (existingAttempt) {
    // SECURITY CHECK: Verify internal order association
    if (existingAttempt.orderId.toString() !== initialOrder._id.toString()) {
      throw new SecurityDiscrepancyError(
        `Payment ID ${paymentId} is already associated with internal order ${existingAttempt.orderId}, cannot associate with ${initialOrder._id}`
      );
    }

    // Verify all relevant identity fields
    if (existingAttempt.paymentId !== paymentId) {
      throw new SecurityDiscrepancyError(
        `Payment ID mismatch on recovery: expected ${paymentId}, found ${existingAttempt.paymentId}`
      );
    }
    if (
      initialOrder.razorpayOrderId &&
      existingAttempt.razorpayOrderId !== initialOrder.razorpayOrderId
    ) {
      throw new SecurityDiscrepancyError(
        `Razorpay order ID mismatch on recovery for ${paymentId}: expected ${initialOrder.razorpayOrderId}, found ${existingAttempt.razorpayOrderId}`
      );
    }
    if (existingAttempt.amountCapturedPaise !== gatewayPayment.amount) {
      throw new SecurityDiscrepancyError(
        `Amount mismatch on recovery for ${paymentId}: expected ${gatewayPayment.amount}, found ${existingAttempt.amountCapturedPaise}`
      );
    }
    if (existingAttempt.currency !== 'INR') {
      throw new SecurityDiscrepancyError(
        `Currency mismatch on recovery for ${paymentId}: expected INR, found ${existingAttempt.currency}`
      );
    }

    if (existingAttempt.status === 'captured') {
      const committedOrder = (await Order.findById(initialOrder._id)) || initialOrder;
      if (eventId && !committedOrder.webhookEventsProcessed.includes(eventId)) {
        committedOrder.webhookEventsProcessed.push(eventId);
        await committedOrder.save();
      }
      return {
        order: committedOrder,
        attempt: existingAttempt,
        duplicateDelivery: true,
        classification: existingAttempt.classification,
        wasLateCapture: existingAttempt.classification === 'compensation',
      };
    }

    // If existing attempt was not captured, retry in a fresh transaction with its existing classification
    return await executeCaptureTransaction(params, existingAttempt.classification);
  }

  // 2. Check if this is a primary unique index collision (Primary Race Collision on orderId_1_classification_1)
  if (isPrimaryUniqueIndexCollision(err)) {
    // A different payment won the primary slot!
    // Re-read the committed winning PaymentAttempt and Order outside the failed transaction
    const freshOrder = await Order.findById(initialOrder._id);
    if (!freshOrder) {
      throw new OrderNotFoundError(
        `Order ${initialOrder._id} not found during primary race recovery`
      );
    }

    const winningPrimaryAttempt = await PaymentAttempt.findOne({
      orderId: freshOrder._id,
      classification: 'primary',
    });

    if (!winningPrimaryAttempt || !freshOrder.primaryPaymentId) {
      // Primary state is inconsistent or was not committed by competitor
      throw err;
    }

    if (freshOrder.primaryPaymentId === paymentId) {
      // The current paymentId actually won primary (concurrent replay detected)
      const thisAttempt = await PaymentAttempt.findOne({ paymentId });
      if (thisAttempt && thisAttempt.status === 'captured') {
        return {
          order: freshOrder,
          attempt: thisAttempt,
          duplicateDelivery: true,
          classification: 'primary',
          wasLateCapture: false,
        };
      }
    }

    // Verify payment identity and order association for the losing payment:
    // Ensure paymentId is not already associated with another order
    const checkAttempt = await PaymentAttempt.findOne({ paymentId });
    if (checkAttempt && checkAttempt.orderId.toString() !== freshOrder._id.toString()) {
      throw new SecurityDiscrepancyError(
        `Payment ID ${paymentId} is already associated with internal order ${checkAttempt.orderId}`
      );
    }

    // This is a different valid payment for the same order:
    // Retry its classification and accounting in a FRESH transaction as duplicate_charge
    return await executeCaptureTransaction(params, 'duplicate_charge');
  }

  // 3. Unrelated duplicate key error: do NOT treat as duplicate delivery!
  throw err;
}

// ============================================================================
// CANONICAL PUBLIC PAYMENT CAPTURE ENTRY POINT
// ============================================================================

export async function processPaymentCapture(
  params: ProcessPaymentCaptureParams
): Promise<CaptureProcessingResult> {
  try {
    return await executeCaptureTransaction(params);
  } catch (err: any) {
    if (isDuplicateKeyError(err)) {
      const { razorpayOrderId, orderId, paymentId } = params;
      let order = await Order.findOne({ razorpayOrderId });
      if (!order && orderId) {
        order = await Order.findOne({ orderId });
      }
      if (!order) {
        throw err;
      }
      if (
        order.amountPaise === undefined ||
        order.amountPaise === null ||
        typeof order.amountPaise !== 'number' ||
        !Number.isInteger(order.amountPaise) ||
        order.amountPaise <= 0
      ) {
        throw new MissingCanonicalAmountError(
          `Order ${order.orderId || order._id} is missing canonical integer amountPaise.`
        );
      }
      const gatewayPayment = await fetchAndVerifyGatewayPayment({
        paymentId,
        expectedOrderId: order.razorpayOrderId || razorpayOrderId,
        expectedPaise: order.amountPaise,
        expectedCurrency: order.currency || params.currency || 'INR',
        cachedEntity: params.verifiedGatewayPayment,
      });

      return await handleDuplicateKeyRecovery(params, err, order, gatewayPayment);
    }
    throw err;
  }
}
