import mongoose, { Schema, Document } from 'mongoose';

export type RefundJobStatus =
  | 'pending'
  | 'processing'
  | 'uncertain'
  | 'succeeded'
  | 'failed_retryable'
  | 'manual_review';

export type RefundJobClassification =
  | 'purchase_compensation'
  | 'duplicate_charge_compensation'
  | 'partial_refund'
  | 'discrepancy_reversal'
  | 'other';

export interface IRefundJobError {
  error: string;
  timestamp: Date;
}

export interface IRefundJob extends Document {
  orderId: mongoose.Types.ObjectId; // Associated internal Order identifier
  targetPaymentId: string; // Razorpay payment ID to be refunded (pay_xxx)
  targetAmountPaise: number; // Target refund amount in integer paise (>= 1)
  currency: string; // Canonical application currency (strictly INR)
  reason: string; // Business or operational reason (e.g. cancelled_order_compensation)
  classification: RefundJobClassification; // Classification category
  idempotencyKey: string; // Stable deterministic idempotency key for this job
  status: RefundJobStatus; // Current lifecycle state of this refund job
  apiDispatched: boolean; // Flag set true BEFORE external HTTP call to Razorpay
  dispatchRecordedAt?: Date; // Timestamp when dispatch intent was persisted
  attempts: number; // Number of dispatch/reconciliation attempts made
  maxRetries: number; // Maximum automated retries allowed before manual_review
  lastError?: string; // Latest error message encountered
  errorHistory: IRefundJobError[]; // Historical log of errors encountered during processing
  manualReviewReason?: string; // Escalation reason if transitioned to manual_review
  providerRefundId?: string; // Razorpay refund ID (rfnd_xxx) once known
  providerIdempotencyKey?: string; // Stable Razorpay X-Refund-Idempotency header key (<= 40 chars)
  leaseWorkerId?: string | null; // Identifier of current worker holding lease
  leaseToken?: string | null; // Unique UUID token for current active lease
  leaseAcquiredAt?: Date | null; // Timestamp when current lease was granted
  leaseExpiresAt?: Date | null; // Lease expiry deadline for distributed fencing
  createdAt: Date;
  updatedAt: Date;
}

export const REFUND_JOB_IMMUTABLE_FIELDS = [
  'orderId',
  'targetPaymentId',
  'targetAmountPaise',
  'currency',
  'reason',
  'classification',
  'idempotencyKey',
] as const;

const RefundJobErrorSchema = new Schema<IRefundJobError>(
  {
    error: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const RefundJobSchema = new Schema<IRefundJob>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: [true, 'Associated orderId reference is required'],
      index: true,
      immutable: true,
    },
    targetPaymentId: {
      type: String,
      required: [true, 'Target payment ID is required'],
      trim: true,
      index: true,
      immutable: true,
    },
    targetAmountPaise: {
      type: Number,
      required: [true, 'Target refund amount in paise is required'],
      min: [1, 'Target refund amount must be at least 1 paisa'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
      immutable: true,
    },
    currency: {
      type: String,
      required: [true, 'Currency is required'],
      default: 'INR',
      trim: true,
      validate: {
        validator: function (val: unknown): boolean {
          return typeof val === 'string' && val === 'INR';
        },
        message: '{VALUE} is not supported. This application strictly requires currency INR.',
      },
      immutable: true,
    },
    reason: {
      type: String,
      required: [true, 'Refund reason is required'],
      trim: true,
      immutable: true,
    },
    classification: {
      type: String,
      enum: {
        values: [
          'purchase_compensation',
          'duplicate_charge_compensation',
          'partial_refund',
          'discrepancy_reversal',
          'other',
        ],
        message: '{VALUE} is not a valid refund job classification',
      },
      default: 'purchase_compensation',
      required: [true, 'Refund job classification is required'],
      index: true,
      immutable: true,
    },
    /**
     * Idempotency Key Specification:
     * The key MUST remain stable and deterministic across all worker retries of the SAME logical refund operation.
     * It must NEVER incorporate ephemeral execution timestamps (e.g. Date.now()), as that would generate a
     * distinct key on each retry and defeat duplicate-dispatch prevention.
     *
     * Canonical stable patterns:
     * - Duplicate-charge compensation: `compensation:duplicate_charge:<targetPaymentId>`
     * - Full purchase cancellation/refund: `refund:full:order:<orderId>:payment:<targetPaymentId>`
     * - Partial return/refund: `refund:partial:order:<orderId>:request:<returnRequestId>:item:<itemId>`
     *
     * Genuinely distinct refund requests (e.g. returning Item B in a separate customer request) receive
     * distinct business request IDs and thus distinct idempotency keys.
     */
    idempotencyKey: {
      type: String,
      required: [true, 'Idempotency key is required for refund jobs'],
      unique: true,
      trim: true,
      index: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: {
        values: [
          'pending',
          'processing',
          'uncertain',
          'succeeded',
          'failed_retryable',
          'manual_review',
        ],
        message: '{VALUE} is not a valid refund job status',
      },
      default: 'pending',
      required: [true, 'Refund job status is required'],
      index: true,
    },
    apiDispatched: {
      type: Boolean,
      default: false,
      index: true,
    },
    dispatchRecordedAt: {
      type: Date,
    },
    attempts: {
      type: Number,
      default: 0,
      min: [0, 'Attempts cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer count',
      },
    },
    maxRetries: {
      type: Number,
      default: 3,
      min: [0, 'Max retries cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer count',
      },
    },
    lastError: {
      type: String,
      trim: true,
    },
    errorHistory: {
      type: [RefundJobErrorSchema],
      default: [],
    },
    manualReviewReason: {
      type: String,
      trim: true,
    },
    providerRefundId: {
      type: String,
      trim: true,
      sparse: true,
    },
    providerIdempotencyKey: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
      maxlength: [40, 'Provider idempotency key cannot exceed 40 characters'],
    },
    leaseWorkerId: {
      type: String,
      default: null,
      trim: true,
    },
    leaseToken: {
      type: String,
      default: null,
      trim: true,
    },
    leaseAcquiredAt: {
      type: Date,
      default: null,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Performance compound index for querying jobs by payment and reason (non-unique to permit legitimate separate jobs)
RefundJobSchema.index({ targetPaymentId: 1, reason: 1 });

// Compound index for worker lease claiming and sweeper triage
RefundJobSchema.index({ status: 1, leaseExpiresAt: 1 });

/**
 * Immutability Guard across Document Saves:
 * Prevents mutation of targetPaymentId, orderId, amount, currency, reason, classification, or idempotencyKey.
 */
RefundJobSchema.pre('save', function (this: any) {
  if (!this.isNew) {
    for (const field of REFUND_JOB_IMMUTABLE_FIELDS) {
      if (this.isModified(field)) {
        throw new Error(`Cannot modify immutable field: ${field}`);
      }
    }
  }
});

/**
 * Immutability Guard across Query Updates (updateOne, updateMany, findOneAndUpdate, replaceOne, findOneAndReplace):
 * Prevents direct database updates from modifying immutable job parameters.
 */
RefundJobSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function (this: any) {
    const update: any = this.getUpdate();
    if (!update) return;

    for (const field of REFUND_JOB_IMMUTABLE_FIELDS) {
      if (
        update[field] !== undefined ||
        (update.$set && update.$set[field] !== undefined) ||
        (update.$unset && update.$unset[field] !== undefined) ||
        (update.$inc && update.$inc[field] !== undefined)
      ) {
        throw new Error(`Cannot update immutable field: ${field}`);
      }
    }
  }
);

export const RefundJob =
  mongoose.models.RefundJob ||
  mongoose.model<IRefundJob>('RefundJob', RefundJobSchema);

export default RefundJob;
