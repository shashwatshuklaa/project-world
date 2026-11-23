import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

export type WebhookEventStatus = 'processing' | 'processed' | 'failed';

export const WEBHOOK_DEFAULT_LEASE_MS = 60_000; // 60 seconds bounded lease

export interface IWebhookEvent extends Document {
  eventId: string;
  event: string;
  status: WebhookEventStatus;
  orderId?: string;
  paymentId?: string;
  payload?: any;
  rawBody?: string;
  signature?: string;
  attempts: number;
  error?: string;
  processedAt?: Date;
  leaseWorkerId?: string | null;
  leaseToken?: string | null;
  leaseAcquiredAt?: Date | null;
  leaseExpiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const WebhookEventSchema = new Schema<IWebhookEvent>(
  {
    eventId: {
      type: String,
      required: [true, 'Webhook event ID is required'],
      unique: true,
      index: true,
    },
    event: {
      type: String,
      required: [true, 'Webhook event name is required'],
      index: true,
    },
    status: {
      type: String,
      enum: {
        values: ['processing', 'processed', 'failed'],
        message: '{VALUE} is not a valid webhook event status',
      },
      default: 'processing',
      index: true,
    },
    orderId: {
      type: String,
      index: true,
    },
    paymentId: {
      type: String,
    },
    payload: {
      type: Schema.Types.Mixed,
    },
    rawBody: {
      type: String,
    },
    signature: {
      type: String,
      trim: true,
    },
    attempts: {
      type: Number,
      default: 1,
      min: 1,
    },
    error: {
      type: String,
    },
    processedAt: {
      type: Date,
    },
    leaseWorkerId: {
      type: String,
      trim: true,
    },
    leaseToken: {
      type: String,
      trim: true,
    },
    leaseAcquiredAt: {
      type: Date,
    },
    leaseExpiresAt: {
      type: Date,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for bounded lease sweeper and crash recovery
WebhookEventSchema.index({ status: 1, leaseExpiresAt: 1 });

export const WebhookEvent =
  mongoose.models.WebhookEvent ||
  mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);

export interface ClaimWebhookResult {
  claimed: boolean;
  leaseToken?: string;
  workerId?: string;
  reason?: 'already_processed' | 'currently_processing' | 'claimed_by_other';
  webhookDoc?: IWebhookEvent | null;
}

export interface ClaimWebhookParams {
  eventId: string;
  eventName: string;
  payload?: any;
  rawBody?: string;
  signature?: string;
  workerId?: string;
  leaseDurationMs?: number;
  now?: Date;
}

/**
 * Claims a webhook event using bounded lease-based recovery.
 * Handles:
 * 1. Initial creation of new event with active lease and durably stored verified payload.
 * 2. Idempotent short-circuit if already processed.
 * 3. Short-circuit if currently processing under an active lease.
 * 4. Crash recovery: re-claims event if processing lease has expired.
 * 5. Retry claim: claims previously failed event.
 */
export async function claimWebhookEvent(params: ClaimWebhookParams): Promise<ClaimWebhookResult> {
  const { eventId, eventName, payload, rawBody, signature, leaseDurationMs = WEBHOOK_DEFAULT_LEASE_MS, now = new Date() } = params;
  const workerId = params.workerId || `wh_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  const initialDoc: any = {
    eventId,
    event: eventName,
    status: 'processing',
    attempts: 1,
    leaseWorkerId: workerId,
    leaseToken,
    leaseAcquiredAt: now,
    leaseExpiresAt,
  };
  if (payload !== undefined) initialDoc.payload = payload;
  if (rawBody !== undefined) initialDoc.rawBody = rawBody;
  if (signature !== undefined) initialDoc.signature = signature;

  try {
    const doc = await WebhookEvent.create(initialDoc);
    return {
      claimed: true,
      leaseToken,
      workerId,
      webhookDoc: doc,
    };
  } catch (err: any) {
    if (err.code === 11000 || err.name === 'MongoServerError' || String(err).includes('E11000')) {
      const existing = await WebhookEvent.findOne({ eventId });
      if (existing?.status === 'processed') {
        return { claimed: false, reason: 'already_processed', webhookDoc: existing };
      }

      if (existing?.status === 'processing') {
        const isLeaseActive =
          existing.leaseExpiresAt && new Date(existing.leaseExpiresAt).getTime() > now.getTime();
        if (isLeaseActive) {
          return { claimed: false, reason: 'currently_processing', webhookDoc: existing };
        }

        const takeoverUpdate: any = {
          leaseWorkerId: workerId,
          leaseToken,
          leaseAcquiredAt: now,
          leaseExpiresAt,
        };
        if (payload !== undefined) takeoverUpdate.payload = payload;
        if (rawBody !== undefined) takeoverUpdate.rawBody = rawBody;
        if (signature !== undefined) takeoverUpdate.signature = signature;

        // Lease expired (worker crashed or timed out): atomic lease takeover
        const claimed = await WebhookEvent.findOneAndUpdate(
          {
            eventId,
            status: 'processing',
            $or: [
              { leaseExpiresAt: { $lte: now } },
              { leaseExpiresAt: null },
              { leaseExpiresAt: { $exists: false } },
            ],
          },
          {
            $set: takeoverUpdate,
            $inc: { attempts: 1 },
          },
          { new: true }
        );

        if (claimed) {
          return { claimed: true, leaseToken, workerId, webhookDoc: claimed };
        }
        return { claimed: false, reason: 'claimed_by_other' };
      }

      const retryUpdate: any = {
        status: 'processing',
        leaseWorkerId: workerId,
        leaseToken,
        leaseAcquiredAt: now,
        leaseExpiresAt,
      };
      if (payload !== undefined) retryUpdate.payload = payload;
      if (rawBody !== undefined) retryUpdate.rawBody = rawBody;
      if (signature !== undefined) retryUpdate.signature = signature;

      // If previously failed, claim retry
      const claimed = await WebhookEvent.findOneAndUpdate(
        { eventId, status: 'failed' },
        {
          $set: retryUpdate,
          $inc: { attempts: 1 },
        },
        { new: true }
      );

      if (claimed) {
        return { claimed: true, leaseToken, workerId, webhookDoc: claimed };
      }
      return { claimed: false, reason: 'claimed_by_other' };
    }
    throw err;
  }
}

/**
 * Fenced completion helper for WebhookEvent.
 * Guarantees that a stale worker whose lease expired or was superseded
 * CANNOT overwrite a newer worker's result.
 */
export async function completeWebhookEvent(params: {
  eventId: string;
  leaseToken: string;
  status: 'processed' | 'failed';
  orderId?: string;
  paymentId?: string;
  error?: string;
}): Promise<boolean> {
  const { eventId, leaseToken, status, orderId, paymentId, error } = params;
  const updateData: any = {
    status,
    leaseWorkerId: null,
    leaseToken: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
  };

  if (status === 'processed') {
    updateData.processedAt = new Date();
  }
  if (orderId) updateData.orderId = orderId;
  if (paymentId) updateData.paymentId = paymentId;
  if (error) updateData.error = error;

  const result = await WebhookEvent.findOneAndUpdate(
    { eventId, leaseToken },
    { $set: updateData },
    { new: true }
  );

  return !!result;
}

export default WebhookEvent;
