import mongoose, { Schema, Document } from 'mongoose';

export type RefundType =
  | 'purchase_compensation'
  | 'duplicate_charge_compensation'
  | 'partial_refund'
  | 'merchant_goodwill'
  | 'other';

export type RefundStatus = 'pending' | 'settled' | 'failed';

export type RefundSettlementSource =
  | 'webhook'
  | 'reconciliation_worker'
  | 'manual_verification';

/**
 * ARCHITECTURAL NOTICE ON REFUND SETTLEMENT:
 * Schema validation checks that settlement metadata is present and internally consistent
 * (e.g. status === 'settled' requires settledAt and settlementSource). However, schema validation
 * alone is NOT proof of external gateway verification. Only a trusted backend settlement service
 * (such as an authenticated Razorpay webhook processor with HMAC SHA-256 verification or an authorized
 * reconciliation worker with signed gateway response) can authoritatively establish settlement.
 */
export interface IRefund extends Document {
  refundId: string; // Globally unique Razorpay refund ID (rfnd_xxx)
  orderId: mongoose.Types.ObjectId; // Associated internal Order identifier
  paymentId: string; // Exact Razorpay payment ID being refunded (pay_xxx)
  refundJobId?: mongoose.Types.ObjectId; // Associated internal RefundJob if originated from worker
  providerRefundId?: string; // Razorpay refund ID (rfnd_xxx) once known
  amountPaise: number; // Refund amount in integer paise (must be at least 1)
  currency: string; // Canonical application currency (strictly INR)
  type: RefundType; // Classification: primary purchase vs duplicate vs partial
  status: RefundStatus; // Settlement status (settled, pending, failed)
  settledAt?: Date; // Timestamp when refund was marked settled
  settlementSource?: RefundSettlementSource; // Source confirming settlement
  settlementVerifiedAt?: Date; // Timestamp when trusted service verified gateway confirmation
  failureReason?: string; // Failure message if settlement failed
  notes?: string; // Operational notes or gateway reference
  createdAt: Date;
  updatedAt: Date;
}

export const REFUND_IMMUTABLE_FIELDS = [
  'refundId',
  'orderId',
  'paymentId',
  'amountPaise',
  'currency',
  'type',
] as const;

const RefundSchema = new Schema<IRefund>(
  {
    refundId: {
      type: String,
      required: [true, 'Refund ID is required'],
      unique: true,
      trim: true,
      index: true,
      immutable: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: [true, 'Associated orderId reference is required'],
      index: true,
      immutable: true,
    },
    paymentId: {
      type: String,
      required: [true, 'Associated paymentId is required'],
      trim: true,
      index: true,
      immutable: true,
    },
    refundJobId: {
      type: Schema.Types.ObjectId,
      ref: 'RefundJob',
      sparse: true,
      index: true,
    },
    providerRefundId: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    amountPaise: {
      type: Number,
      required: [true, 'Refund amount in paise is required'],
      min: [1, 'Refund amount must be at least 1 paisa'],
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
    type: {
      type: String,
      enum: {
        values: [
          'purchase_compensation',
          'duplicate_charge_compensation',
          'partial_refund',
          'merchant_goodwill',
          'other',
        ],
        message: '{VALUE} is not a valid refund type',
      },
      required: [true, 'Refund type is required'],
      index: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'settled', 'failed'],
        message: '{VALUE} is not a valid refund status',
      },
      default: 'pending', // Default is strictly pending, never automatically settled
      required: [true, 'Refund status is required'],
      index: true,
    },
    settledAt: {
      type: Date,
      required: [
        function (this: any) {
          const status = typeof this.get === 'function' ? this.get('status') : this?.status;
          return status === 'settled';
        },
        'settledAt timestamp is strictly required when refund status is settled',
      ],
      validate: {
        validator: function (this: any, val: Date | undefined): boolean {
          const status = typeof this.get === 'function' ? this.get('status') : this?.status;
          if ((status === 'pending' || status === 'failed') && val != null) {
            return false;
          }
          if (status === 'settled' && !(val instanceof Date && !isNaN(val.getTime()))) {
            return false;
          }
          return true;
        },
        message:
          'settledAt timestamp is required when refund status is settled, and must not be set when pending or failed',
      },
    },
    settlementSource: {
      type: String,
      enum: {
        values: ['webhook', 'reconciliation_worker', 'manual_verification'],
        message: '{VALUE} is not a valid refund settlement source',
      },
      required: [
        function (this: any) {
          const status = typeof this.get === 'function' ? this.get('status') : this?.status;
          return status === 'settled';
        },
        'settlementSource is strictly required when refund status is settled',
      ],
      validate: {
        validator: function (this: any, val: unknown): boolean {
          const status = typeof this.get === 'function' ? this.get('status') : this?.status;
          if ((status === 'pending' || status === 'failed') && val != null) {
            return false;
          }
          if (status === 'settled' && !val) {
            return false;
          }
          return true;
        },
        message:
          'A pending refund cannot have a settlementSource populated; failed refunds also cannot have settlement metadata',
      },
      index: true,
    },
    settlementVerifiedAt: {
      type: Date,
      validate: {
        validator: function (this: any, val: Date | undefined): boolean {
          const status = typeof this.get === 'function' ? this.get('status') : this?.status;
          if ((status === 'pending' || status === 'failed') && val != null) {
            return false;
          }
          return true;
        },
        message: 'A pending or failed refund cannot have a settlementVerifiedAt timestamp populated',
      },
    },
    failureReason: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for querying refunds by order and payment attempt
RefundSchema.index({ orderId: 1, paymentId: 1 });

RefundSchema.post('init', function (this: any) {
  this._originalStatus = this.status;
  this._originalRefundJobId = this.refundJobId;
});

/**
 * Immutability Guard across Document Saves:
 * Prevents mutation of refundId, paymentId, orderId, amount, currency, type, or assigned refundJobId.
 * Transition Guard: Prevents a failed refund from transitioning to settled.
 */
RefundSchema.pre('save', function (this: any) {
  if (!this.isNew) {
    for (const field of REFUND_IMMUTABLE_FIELDS) {
      if (this.isModified(field)) {
        throw new Error(`Cannot modify immutable field: ${field}`);
      }
    }
    // refundJobId: once assigned, cannot be changed or removed
    if (this.isModified('refundJobId') && this.isSelected('refundJobId')) {
      const orig = this._originalRefundJobId || this._original?.refundJobId;
      if (orig && orig.toString() !== this.refundJobId?.toString()) {
        throw new Error('Cannot reassign immutable field: refundJobId once assigned');
      }
    }

    // Transition Guard: A failed refund cannot transition to settled
    if (this.isModified('status')) {
      const origStatus = this._originalStatus || this._original?.status;
      if (origStatus === 'failed' && this.status === 'settled') {
        throw new Error('Invalid refund status transition: A failed refund cannot transition to settled');
      }
    }
  }
});

RefundSchema.post('save', function (this: any) {
  this._originalStatus = this.status;
  this._originalRefundJobId = this.refundJobId;
});

/**
 * Immutability Guard across Query Updates (updateOne, updateMany, findOneAndUpdate, replaceOne, findOneAndReplace):
 * Prevents direct database updates from modifying immutable financial fields.
 * Prevents direct database updates from transitioning a failed refund to settled or adding settlement metadata.
 */
RefundSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function (this: any) {
    const update: any = this.getUpdate();
    if (!update) return;

    for (const field of REFUND_IMMUTABLE_FIELDS) {
      if (
        update[field] !== undefined ||
        (update.$set && update.$set[field] !== undefined) ||
        (update.$unset && update.$unset[field] !== undefined) ||
        (update.$inc && update.$inc[field] !== undefined)
      ) {
        throw new Error(`Cannot update immutable field: ${field}`);
      }
    }

    const newStatus = update.status || update.$set?.status;
    const filter = typeof this.getFilter === 'function' ? this.getFilter() : {};

    if (newStatus === 'settled') {
      if (filter.status === 'failed') {
        throw new Error('Invalid refund status transition: A failed refund cannot transition to settled');
      }
    }

    const setsSettlement =
      update.settledAt !== undefined ||
      update.settlementSource !== undefined ||
      update.settlementVerifiedAt !== undefined ||
      (update.$set &&
        (update.$set.settledAt !== undefined ||
          update.$set.settlementSource !== undefined ||
          update.$set.settlementVerifiedAt !== undefined));

    if (setsSettlement) {
      if (newStatus === 'failed' || filter.status === 'failed') {
        throw new Error('Cannot set settlement metadata on a failed refund');
      }
    }
  }
);

export const Refund =
  mongoose.models.Refund || mongoose.model<IRefund>('Refund', RefundSchema);

export default Refund;
