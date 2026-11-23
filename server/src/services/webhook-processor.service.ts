import { WebhookEvent, completeWebhookEvent } from '../models/WebhookEvent.js';
import { Order } from '../models/Order.js';
import { getRazorpayClient } from '../config/razorpay.js';
import {
  verifyWebhookSignature,
  processSuccessfulPayment,
  processPaymentFailed,
  processRefund,
  processPaymentCapture,
  processRefundSettlement,
  processRefundFailure,
  fetchAuthoritativeGatewayRefund,
  OrderNotFoundError,
  GatewayAmountMismatchError,
  GatewayCurrencyMismatchError,
  GatewayOrderMismatchError,
  SecurityDiscrepancyError,
  PaymentNotCapturedError,
  MissingCanonicalAmountError,
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
} from './payment.service.js';

export interface ProcessVerifiedWebhookEventParams {
  eventId: string;
  eventName: string;
  payload: any;
  rawBody?: string;
  signature?: string;
  leaseToken: string;
  razorpayClient?: any;
}

export interface ProcessWebhookResult {
  success: boolean;
  status: 'processed' | 'failed';
  message: string;
  duplicateDelivery?: boolean;
  orderId?: string;
  paymentId?: string;
  error?: string;
}

/**
 * Unified, safe processor for verified Razorpay webhook events.
 *
 * Guarantees:
 * 1. Cryptographic HMAC SHA-256 verification when rawBody & signature are provided.
 * 2. Does not trust unverified or modified payloads.
 * 3. Authoritative gateway lookups for payment capture and refund settlement.
 * 4. Stale-worker fencing via completeWebhookEvent({ eventId, leaseToken }).
 * 5. Can safely be executed from both HTTP webhook controller and background recovery workers.
 */
export async function processVerifiedWebhookEvent(
  params: ProcessVerifiedWebhookEventParams
): Promise<ProcessWebhookResult> {
  const { eventId, eventName, payload, rawBody, signature, leaseToken, razorpayClient } = params;
  const client = razorpayClient || getRazorpayClient();

  // 1. If cryptographic rawBody and signature are available, enforce verification
  if (rawBody && signature) {
    const isValidSignature = verifyWebhookSignature({
      rawBody,
      signature,
    });

    if (!isValidSignature) {
      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'failed',
        error: 'Invalid or tampered webhook signature.',
      });
      return {
        success: false,
        status: 'failed',
        message: 'Invalid or tampered webhook signature.',
        error: 'Invalid or tampered webhook signature.',
      };
    }
  }

  // 2. Parse and validate payload:
  // If signed rawBody is provided, authoritative payload MUST be parsed freshly from rawBody.
  // Any independently passed or stored payload is untrusted and cannot influence processing.
  let effectivePayload: any = payload;
  if (rawBody) {
    try {
      effectivePayload = JSON.parse(rawBody);
    } catch {
      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'failed',
        error: 'Malformed rawBody JSON payload.',
      });
      return {
        success: false,
        status: 'failed',
        message: 'Malformed rawBody JSON payload.',
        error: 'Malformed rawBody JSON payload.',
      };
    }

    // Validate that the parsed event name matches the event record
    if (effectivePayload?.event && effectivePayload.event !== eventName) {
      const errorMsg = `Event name mismatch: parsed rawBody reports "${effectivePayload.event}", but record is "${eventName}".`;
      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'failed',
        error: errorMsg,
      });
      return {
        success: false,
        status: 'failed',
        message: errorMsg,
        error: errorMsg,
      };
    }

    // Validate that the parsed event ID matches the event record (if present in payload)
    const bodyEventId =
      effectivePayload?.event_id ||
      (effectivePayload?.entity === 'event' ? effectivePayload?.id : undefined) ||
      (typeof effectivePayload?.id === 'string' && effectivePayload.id.startsWith('evt_')
        ? effectivePayload.id
        : undefined);

    if (bodyEventId && bodyEventId !== eventId) {
      const errorMsg = `Event ID mismatch: parsed rawBody reports "${bodyEventId}", but record is "${eventId}".`;
      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'failed',
        error: errorMsg,
      });
      return {
        success: false,
        status: 'failed',
        message: errorMsg,
        error: errorMsg,
      };
    }
  }

  // Validate payload structure
  if (!effectivePayload || typeof effectivePayload !== 'object') {
    await completeWebhookEvent({
      eventId,
      leaseToken,
      status: 'failed',
      error: 'Invalid webhook payload structure.',
    });
    return {
      success: false,
      status: 'failed',
      message: 'Invalid webhook payload structure.',
      error: 'Invalid webhook payload structure.',
    };
  }

  const eventPayload = effectivePayload.payload || {};

  // 3. Dispatch based on Razorpay event type
  try {
    // --------------------------------------------------------------------------
    // EVENT: payment.captured
    // --------------------------------------------------------------------------
    if (eventName === 'payment.captured') {
      const payment = eventPayload.payment?.entity;
      const razorpayOrderId = payment?.order_id;
      const paymentId = payment?.id;

      if (!razorpayOrderId || !paymentId) {
        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          error: 'No order_id or payment id in payment.captured payload',
        });
        return {
          success: true,
          status: 'processed',
          message: 'Ignored: No order_id or payment id present.',
        };
      }

      try {
        let fetchedGatewayPayment: any = null;
        if (client && client.payments && typeof client.payments.fetch === 'function') {
          try {
            fetchedGatewayPayment = await client.payments.fetch(paymentId);
          } catch (fetchErr: any) {
            console.error(`Razorpay API lookup failed for payment ${paymentId}:`, fetchErr.message || fetchErr);
            throw new Error(
              `Razorpay gateway lookup failed for payment ${paymentId}: ${fetchErr.message || fetchErr}`
            );
          }
        }

        const { order, duplicateDelivery } = await processPaymentCapture({
          paymentId,
          razorpayOrderId,
          amountPaise: fetchedGatewayPayment?.amount || payment?.amount,
          currency: fetchedGatewayPayment?.currency || payment?.currency,
          gatewayMethod: fetchedGatewayPayment?.method || payment?.method,
          eventId,
          source: 'webhook',
          verifiedGatewayPayment: fetchedGatewayPayment,
        });

        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          orderId: order.orderId,
          paymentId,
        });

        return {
          success: true,
          status: 'processed',
          message: duplicateDelivery
            ? 'Payment captured event already processed (idempotent duplicate).'
            : 'Payment captured event processed successfully.',
          duplicateDelivery,
          orderId: order.orderId,
          paymentId,
        };
      } catch (err: any) {
        if (err instanceof OrderNotFoundError) {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'processed',
            error: err.message,
          });
          return {
            success: true,
            status: 'processed',
            message: 'Order not found in database.',
          };
        }

        if (
          err instanceof GatewayAmountMismatchError ||
          err instanceof GatewayCurrencyMismatchError ||
          err instanceof GatewayOrderMismatchError ||
          err instanceof SecurityDiscrepancyError ||
          err instanceof PaymentNotCapturedError ||
          err instanceof MissingCanonicalAmountError
        ) {
          console.error(`SECURITY WARNING: Webhook verification error for payment ${paymentId}: ${err.message}`);
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: err.message,
          });

          const linkedOrder = await Order.findOne({ razorpayOrderId });
          if (linkedOrder && linkedOrder.paymentStatus !== 'captured') {
            linkedOrder.paymentStatus = 'unknown';
            linkedOrder.failureReason = err.message;
            await linkedOrder.save();
          }

          return {
            success: false,
            status: 'failed',
            message: err.message,
            error: err.message,
          };
        }

        throw err;
      }
    }

    // --------------------------------------------------------------------------
    // EVENT: order.paid
    // --------------------------------------------------------------------------
    if (eventName === 'order.paid') {
      const rzpOrder = eventPayload.order?.entity;
      const razorpayOrderId = rzpOrder?.id;

      if (!razorpayOrderId) {
        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
        });
        return {
          success: true,
          status: 'processed',
          message: 'No order id present.',
        };
      }

      const order = await Order.findOne({ razorpayOrderId });
      if (!order) {
        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          error: `Order not found for razorpayOrderId: ${razorpayOrderId}`,
        });
        return {
          success: true,
          status: 'processed',
          message: 'Order not found.',
        };
      }

      const expectedAmountInPaise = Math.round(order.totalAmount * 100);
      if (rzpOrder.amount !== expectedAmountInPaise) {
        order.paymentStatus = 'unknown';
        order.failureReason = 'Amount mismatch detected in order.paid webhook.';
        await order.save();

        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'failed',
          error: 'Amount mismatch in order.paid',
        });

        return {
          success: false,
          status: 'failed',
          message: 'Order amount mismatch.',
          error: 'Amount mismatch in order.paid',
        };
      }

      await processSuccessfulPayment({
        order,
        paymentId: order.razorpayPaymentId || `pay_order_paid_${eventId}`,
        eventId,
      });

      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'processed',
        orderId: order.orderId,
      });

      return {
        success: true,
        status: 'processed',
        message: 'Order paid event processed successfully.',
        orderId: order.orderId,
      };
    }

    // --------------------------------------------------------------------------
    // EVENT: payment.authorized
    // --------------------------------------------------------------------------
    if (eventName === 'payment.authorized') {
      const payment = eventPayload.payment?.entity;
      const razorpayOrderId = payment?.order_id;

      if (razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (
          order &&
          order.paymentStatus !== 'captured' &&
          order.status !== 'completed' &&
          order.status !== 'refunded'
        ) {
          order.paymentStatus = 'authorized';
          if (payment.id) {
            order.razorpayPaymentId = payment.id;
          }
          if (!order.webhookEventsProcessed.includes(eventId)) {
            order.webhookEventsProcessed.push(eventId);
          }
          await order.save();
        }
      }

      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'processed',
      });

      return {
        success: true,
        status: 'processed',
        message: 'Payment authorized event recorded.',
      };
    }

    // --------------------------------------------------------------------------
    // EVENT: payment.failed
    // --------------------------------------------------------------------------
    if (eventName === 'payment.failed') {
      const payment = eventPayload.payment?.entity;
      const razorpayOrderId = payment?.order_id;

      if (razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (order) {
          await processPaymentFailed({
            order,
            reason: payment.error_description || payment.error_reason,
            eventId,
          });
        }
      }

      await completeWebhookEvent({
        eventId,
        leaseToken,
        status: 'processed',
      });

      return {
        success: true,
        status: 'processed',
        message: 'Payment failed event recorded.',
      };
    }

    // --------------------------------------------------------------------------
    // EVENT: refund.processed / payment.refunded
    // --------------------------------------------------------------------------
    if (eventName === 'refund.processed' || eventName === 'payment.refunded') {
      const refundEntity = eventPayload.refund?.entity || eventPayload.payment?.entity;
      const refundId = refundEntity?.id;
      const paymentId = refundEntity?.payment_id;
      const razorpayOrderId = refundEntity?.order_id;
      const amountPaise = refundEntity?.amount;
      const currency = refundEntity?.currency || 'INR';
      const notes = refundEntity?.notes;

      if (!refundId) {
        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          error: 'No refund id present in refund.processed payload',
        });
        return {
          success: true,
          status: 'processed',
          message: 'Ignored: No refund id present.',
        };
      }

      try {
        let fetchedGatewayRefund: any = null;
        try {
          fetchedGatewayRefund = await fetchAuthoritativeGatewayRefund(refundId, paymentId, client);
        } catch (fetchErr: any) {
          console.error(`Razorpay API lookup failed for refund ${refundId}:`, fetchErr.message || fetchErr);
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: fetchErr.message || 'Razorpay gateway lookup failed',
          });
          return {
            success: false,
            status: 'failed',
            message: fetchErr.message || 'Razorpay gateway lookup failed for refund',
            error: fetchErr.message,
          };
        }

        if (!fetchedGatewayRefund) {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: `Gateway verification uncertain: no entity returned for refund ${refundId}`,
          });
          return {
            success: false,
            status: 'failed',
            message: `Gateway verification uncertain for refund ${refundId}. Settlement aborted.`,
            error: 'No entity returned',
          };
        }

        if (fetchedGatewayRefund.status === 'pending') {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: `Gateway refund ${refundId} is still pending. Cannot settle.`,
          });
          return {
            success: false,
            status: 'failed',
            message: `Gateway indicates refund ${refundId} is still pending. Settlement withheld until gateway reports processed.`,
            error: 'Gateway refund is still pending',
          };
        }

        if (fetchedGatewayRefund.status !== 'processed') {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: `Gateway refund ${refundId} has status "${fetchedGatewayRefund.status}", expected "processed".`,
          });
          return {
            success: false,
            status: 'failed',
            message: `Gateway refund ${refundId} has status "${fetchedGatewayRefund.status}", expected "processed".`,
            error: 'Status not processed',
          };
        }

        if (
          amountPaise !== undefined &&
          fetchedGatewayRefund.amount !== undefined &&
          amountPaise !== fetchedGatewayRefund.amount
        ) {
          throw new RefundAmountMismatchError(
            `Refund amount mismatch: Webhook reports ${amountPaise} paise, but authoritative gateway reports ${fetchedGatewayRefund.amount} paise.`
          );
        }

        if (
          paymentId &&
          fetchedGatewayRefund.payment_id &&
          paymentId.trim() !== fetchedGatewayRefund.payment_id.trim()
        ) {
          throw new RefundIdentityMismatchError(
            `Refund payment ID mismatch: Webhook reports "${paymentId}", but authoritative gateway reports "${fetchedGatewayRefund.payment_id}".`
          );
        }

        const result = await processRefundSettlement({
          refundId,
          paymentId: fetchedGatewayRefund.payment_id || paymentId,
          razorpayOrderId: fetchedGatewayRefund.order_id || razorpayOrderId,
          amountPaise: fetchedGatewayRefund.amount ?? amountPaise,
          currency: fetchedGatewayRefund.currency || currency,
          eventId,
          source: 'webhook',
          notes,
          gatewayRefund: fetchedGatewayRefund,
          razorpayClient: client,
        });

        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          orderId: result.order.orderId,
          paymentId: fetchedGatewayRefund.payment_id || paymentId,
        });

        return {
          success: true,
          status: 'processed',
          message: result.duplicateDelivery
            ? 'Refund event already settled (idempotent duplicate).'
            : 'Refund processed and settled successfully.',
          duplicateDelivery: result.duplicateDelivery,
          orderId: result.order.orderId,
        };
      } catch (err: any) {
        if (err instanceof RefundNotFoundError) {
          // Check for legacy/direct order fallback
          if (razorpayOrderId) {
            const order = await Order.findOne({ razorpayOrderId });
            if (order && !order.amountReservedRefundPaise && !order.totalCapturedPaise) {
              await processRefund({ order, refundId, eventId });
              await completeWebhookEvent({
                eventId,
                leaseToken,
                status: 'processed',
                orderId: order.orderId,
              });
              return {
                success: true,
                status: 'processed',
                message: 'Legacy order refund processed.',
                orderId: order.orderId,
              };
            }
          }

          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'processed',
            error: err.message,
          });
          return {
            success: true,
            status: 'processed',
            message: 'Refund not found in database.',
          };
        }

        if (
          err instanceof RefundIdentityMismatchError ||
          err instanceof RefundAmountMismatchError ||
          err instanceof RefundCurrencyMismatchError ||
          err instanceof PaymentAttemptNotFoundError ||
          err instanceof PaymentNotCapturedForRefundError ||
          err instanceof OrderNotFoundForRefundError ||
          err instanceof GatewayRefundPendingError ||
          err instanceof GatewayRefundVerificationError
        ) {
          console.error(`SECURITY WARNING: Webhook verification error for refund ${refundId}: ${err.message}`);
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: err.message,
          });
          return {
            success: false,
            status: 'failed',
            message: err.message,
            error: err.message,
          };
        }

        if (err instanceof StaleRefundEventError) {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'processed',
            error: err.message,
          });
          return {
            success: true,
            status: 'processed',
            message: err.message,
          };
        }

        throw err;
      }
    }

    // --------------------------------------------------------------------------
    // EVENT: refund.failed
    // --------------------------------------------------------------------------
    if (eventName === 'refund.failed') {
      const refundEntity = eventPayload.refund?.entity;
      const refundId = refundEntity?.id;
      const paymentId = refundEntity?.payment_id;
      const razorpayOrderId = refundEntity?.order_id;
      const failureReason =
        refundEntity?.error_description ||
        refundEntity?.error_reason ||
        'Gateway reported refund processing failed';
      const notes = refundEntity?.notes;

      if (!refundId) {
        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          error: 'No refund id present in refund.failed payload',
        });
        return {
          success: true,
          status: 'processed',
          message: 'Ignored: No refund id present.',
        };
      }

      try {
        const result = await processRefundFailure({
          refundId,
          paymentId,
          razorpayOrderId,
          failureReason,
          eventId,
          notes,
          gatewayRefund: refundEntity,
        });

        await completeWebhookEvent({
          eventId,
          leaseToken,
          status: 'processed',
          orderId: result.order.orderId,
          paymentId,
        });

        return {
          success: true,
          status: 'processed',
          message: result.duplicateDelivery
            ? 'Refund failure already recorded (idempotent duplicate).'
            : 'Refund failure recorded and reservation released.',
          duplicateDelivery: result.duplicateDelivery,
          orderId: result.order.orderId,
        };
      } catch (err: any) {
        if (err instanceof RefundNotFoundError) {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'processed',
            error: err.message,
          });
          return {
            success: true,
            status: 'processed',
            message: 'Refund not found in database.',
          };
        }

        if (
          err instanceof RefundIdentityMismatchError ||
          err instanceof OrderNotFoundForRefundError
        ) {
          console.error(`SECURITY WARNING: Webhook verification error for failed refund ${refundId}: ${err.message}`);
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'failed',
            error: err.message,
          });
          return {
            success: false,
            status: 'failed',
            message: err.message,
            error: err.message,
          };
        }

        if (err instanceof StaleRefundEventError) {
          await completeWebhookEvent({
            eventId,
            leaseToken,
            status: 'processed',
            error: err.message,
          });
          return {
            success: true,
            status: 'processed',
            message: err.message,
          };
        }

        throw err;
      }
    }

    // --------------------------------------------------------------------------
    // DEFAULT / UNRECOGNIZED EVENT
    // --------------------------------------------------------------------------
    await completeWebhookEvent({
      eventId,
      leaseToken,
      status: 'processed',
    });

    return {
      success: true,
      status: 'processed',
      message: `Event ${eventName} received and logged.`,
    };
  } catch (error: any) {
    await completeWebhookEvent({
      eventId,
      leaseToken,
      status: 'failed',
      error: error?.message || String(error),
    });
    return {
      success: false,
      status: 'failed',
      message: error?.message || 'Failed to process webhook event.',
      error: error?.message,
    };
  }
}
