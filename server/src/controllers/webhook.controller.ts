import { Request, Response } from 'express';
import { claimWebhookEvent } from '../models/WebhookEvent.js';
import { getRazorpayClient } from '../config/razorpay.js';
import { verifyWebhookSignature } from '../services/payment.service.js';
import { processVerifiedWebhookEvent } from '../services/webhook-processor.service.js';

/**
 * POST /api/webhooks/razorpay
 * Secure webhook receiver for Razorpay payment lifecycle events.
 * 1. Verifies HMAC SHA-256 signature against exact raw request body.
 * 2. Enforces event idempotency and crash recovery using bounded lease-based claiming.
 * 3. Durably stores verified payload, rawBody, and signature for safe automated background replay.
 * 4. Handles payment.captured, order.paid, payment.authorized, payment.failed, refund.processed, refund.failed.
 * 5. Never downgrades already captured/paid orders.
 * 6. Authoritatively fetches gateway status via SDK before altering accounting.
 * 7. Never logs secrets or complete signatures.
 */
export async function handleRazorpayWebhook(req: Request, res: Response): Promise<void> {
  try {
    // 1. Extract signature from header
    const rawSignature =
      req.headers['x-razorpay-signature'] || req.headers['X-Razorpay-Signature'];
    const signature = typeof rawSignature === 'string' ? rawSignature.trim() : '';

    if (!signature) {
      res.status(400).json({
        success: false,
        message: 'Missing Razorpay webhook signature.',
      });
      return;
    }

    // 2. Extract exact raw request body
    const rawBody =
      (req as any).rawBody ||
      (Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}), 'utf8'));

    // 3. Verify HMAC SHA-256 signature
    const isValidSignature = verifyWebhookSignature({
      rawBody,
      signature,
    });

    if (!isValidSignature) {
      res.status(400).json({
        success: false,
        message: 'Invalid webhook signature.',
      });
      return;
    }

    // 4. Parse JSON payload
    let payload: any = req.body;
    if (Buffer.isBuffer(payload)) {
      try {
        payload = JSON.parse(payload.toString('utf8'));
      } catch {
        res.status(400).json({
          success: false,
          message: 'Malformed webhook JSON payload.',
        });
        return;
      }
    } else if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        res.status(400).json({
          success: false,
          message: 'Malformed webhook JSON payload.',
        });
        return;
      }
    }

    if (!payload || typeof payload !== 'object') {
      res.status(400).json({
        success: false,
        message: 'Invalid webhook payload structure.',
      });
      return;
    }

    // 5. Extract canonical event identifier from required header
    const rawEventId =
      req.headers['x-razorpay-event-id'] ||
      req.headers['X-Razorpay-Event-Id'];

    const eventId = typeof rawEventId === 'string' ? rawEventId.trim() : '';
    if (!eventId) {
      res.status(400).json({
        success: false,
        message: 'Missing Razorpay event identifier (X-Razorpay-Event-Id header is required).',
      });
      return;
    }

    // 5b. If the signed JSON body optionally contains an event ID, validate that it matches the header ID
    const bodyEventId =
      payload.event_id ||
      (payload.entity === 'event' ? payload.id : undefined) ||
      (typeof payload.id === 'string' && payload.id.startsWith('evt_') ? payload.id : undefined);

    if (bodyEventId && bodyEventId !== eventId) {
      res.status(400).json({
        success: false,
        message: `Event ID mismatch: header reports "${eventId}", but body reports "${bodyEventId}".`,
      });
      return;
    }

    const eventName = typeof payload.event === 'string' ? payload.event : 'unknown';
    const rawBodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

    // 6. Enforce event idempotency & crash recovery using bounded lease-based claiming
    // Durably stores the verified payload, rawBody, and signature for safe crash recovery & replay.
    const claimResult = await claimWebhookEvent({
      eventId,
      eventName,
      payload,
      rawBody: rawBodyStr,
      signature,
    });

    if (!claimResult.claimed) {
      if (claimResult.reason === 'already_processed') {
        res.status(200).json({
          success: true,
          message: 'Webhook event already processed.',
        });
        return;
      }

      if (claimResult.reason === 'currently_processing') {
        res.status(200).json({
          success: true,
          message: 'Webhook event is currently being processed.',
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Webhook event already claimed by another process.',
      });
      return;
    }

    // 7. Dispatch verified event to unified processor
    const processResult = await processVerifiedWebhookEvent({
      eventId,
      eventName,
      payload,
      rawBody: rawBodyStr,
      signature,
      leaseToken: claimResult.leaseToken!,
      razorpayClient: getRazorpayClient(),
    });

    if (processResult.success) {
      res.status(200).json({
        success: true,
        message: processResult.message,
      });
    } else {
      res.status(400).json({
        success: false,
        message: processResult.message || processResult.error || 'Failed to process webhook event.',
      });
    }
  } catch (error: any) {
    console.error('Unexpected error in handleRazorpayWebhook:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process webhook event.',
    });
  }
}
