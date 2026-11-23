import mongoose, { Schema, Document } from 'mongoose';

export type PaymentAttemptStatus =
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'held'
  | 'discrepancy';

export type PaymentAttemptClassification =
  | 'primary'
  | 'duplicate_charge'
  | 'compensation'
  | 'unassigned';

export interface IPaymentAttempt extends Document {
  paymentId: string; // Globally unique Razorpay payment identifier (e.g. pay_xxx)
  orderId: mongoose.Types.ObjectId; // Associated internal Order identifier
  razorpayOrderId: string; // Associated Razorpay order identifier (order_xxx)
  amountCapturedPaise: number; // Captured amount in integer paise (non-negative)
  currency: string; // Canonical application currency (strictly INR)
  status: PaymentAttemptStatus; // State of this specific payment attempt
  classification: PaymentAttemptClassification; // Financial role: primary vs duplicate vs compensation
  gatewayMethod?: string; // Card, UPI, Netbanking, Wallet, etc.
  failureReason?: string; // Failure or discrepancy reason message
  notes?: string; // Additional operational notes
  createdAt: Date;
  updatedAt: Date;
}

export const PAYMENT_ATTEMPT_IMMUTABLE_FIELDS = [
  'paymentId',
  'orderId',
  'razorpayOrderId',
  'amountCapturedPaise',
  'currency',
  'classification',
] as const;

const PaymentAttemptSchema = new Schema<IPaymentAttempt>(
  {
    paymentId: {
      type: String,
      required: [true, 'Payment ID is required'],
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
    razorpayOrderId: {
      type: String,
      required: [true, 'Razorpay order ID is required'],
      trim: true,
      index: true,
      immutable: true,
    },
    amountCapturedPaise: {
      type: Number,
      required: [true, 'Captured amount in paise is required'],
      min: [0, 'Captured amount cannot be negative'],
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
    status: {
      type: String,
      enum: {
        values: ['authorized', 'captured', 'failed', 'held', 'discrepancy'],
        message: '{VALUE} is not a valid payment attempt status',
      },
      required: [true, 'Payment status is required'],
      default: 'authorized',
      index: true,
    },
    classification: {
      type: String,
      enum: {
        values: ['primary', 'duplicate_charge', 'compensation', 'unassigned'],
        message: '{VALUE} is not a valid payment attempt classification',
      },
      default: 'primary',
      required: [true, 'Payment attempt classification is required'],
      index: true,
      immutable: true,
    },
    gatewayMethod: {
      type: String,
      trim: true,
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

// Compound index for querying attempts by order and classification
// Enforces at most ONE primary payment attempt per order at database level
PaymentAttemptSchema.index(
  { orderId: 1, classification: 1 },
  {
    unique: true,
    partialFilterExpression: { classification: 'primary' },
  }
);

/**
 * Immutability Guard across Document Saves:
 * Prevents mutation of financial identity and historical facts on existing payment attempts.
 */
PaymentAttemptSchema.pre('save', function (this: any) {
  if (!this.isNew) {
    for (const field of PAYMENT_ATTEMPT_IMMUTABLE_FIELDS) {
      if (this.isModified(field)) {
        throw new Error(`Cannot modify immutable field: ${field}`);
      }
    }
  }
});

/**
 * Immutability Guard across Query Updates (updateOne, updateMany, findOneAndUpdate, replaceOne, findOneAndReplace):
 * Prevents direct database updates from modifying immutable financial fields.
 * Permits $setOnInsert for idempotent upserts.
 */
PaymentAttemptSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
  function (this: any) {
    const update: any = this.getUpdate();
    if (!update) return;

    for (const field of PAYMENT_ATTEMPT_IMMUTABLE_FIELDS) {
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

export const PaymentAttempt =
  mongoose.models.PaymentAttempt ||
  mongoose.model<IPaymentAttempt>('PaymentAttempt', PaymentAttemptSchema);

export default PaymentAttempt;
