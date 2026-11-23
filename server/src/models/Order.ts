import mongoose, { Schema, Document } from 'mongoose';

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refunded';

export type PaymentStatus =
  | 'creating'
  | 'created'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'retryable_failure'
  | 'unknown'
  | 'refunded'
  | 'duplicate_charge_detected'
  | 'security_discrepancy'
  | 'held_for_review'
  | 'refund_pending'
  | 'partially_refunded';

export interface IOrderItem {
  projectId: mongoose.Types.ObjectId;
  cartItemId?: mongoose.Types.ObjectId;
  projectSlug: string;
  title: string;
  price: number;
  quantity: number;
  customization?: string;
  category?: string;
  subcategory?: string;
  image?: string;
}

export interface IOrder extends Document {
  orderId: string; // Internal order ID
  receipt: string; // Persistent deterministic Razorpay receipt (max 40 chars)
  userId: mongoose.Types.ObjectId;
  items: IOrderItem[];
  totalAmount: number; // Server-calculated canonical total amount in INR
  amountPaise: number; // Canonical integer amount in paise originally persisted for Razorpay order
  currency: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  idempotencyKey?: string;
  webhookEventsProcessed: string[];
  cartReconciled: boolean;
  paymentMethod?: string;
  paidAt?: Date;
  failureReason?: string;

  // Dual-Ledger Financial Accounting Fields (Integer Paise)
  totalCapturedPaise: number;
  purchaseCapturedPaise: number;
  duplicateCapturedPaise: number;
  amountReservedRefundPaise: number;
  confirmedRefundPaise: number;
  purchaseRefundedPaise: number;
  duplicateRefundedPaise: number;
  primaryPaymentId?: string;

  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: [true, 'Project ID reference is required'],
    },
    cartItemId: {
      type: Schema.Types.ObjectId,
    },
    projectSlug: {
      type: String,
      required: [true, 'Project slug is required'],
    },
    title: {
      type: String,
      required: [true, 'Project title is required'],
    },
    price: {
      type: Number,
      required: [true, 'Item price is required'],
      min: [0, 'Item price cannot be negative'],
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
    },
    customization: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: '',
    },
    subcategory: {
      type: String,
      default: '',
    },
    image: {
      type: String,
      default: '',
    },
  },
  { _id: false }
);

const OrderSchema = new Schema<IOrder>(
  {
    orderId: {
      type: String,
      required: [true, 'Order identifier is required'],
      unique: true,
      index: true,
    },
    receipt: {
      type: String,
      required: [true, 'Razorpay receipt identifier is required'],
      unique: true,
      index: true,
      maxlength: [40, 'Receipt cannot exceed 40 characters'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    items: {
      type: [OrderItemSchema],
      required: [true, 'Order must contain at least one item'],
      validate: [
        (items: IOrderItem[]) => items && items.length > 0,
        'Order items array cannot be empty',
      ],
    },
    totalAmount: {
      type: Number,
      required: [true, 'Total amount is required'],
      min: [0, 'Total amount cannot be negative'],
    },
    amountPaise: {
      type: Number,
      default: function (this: any) {
        if (typeof this.totalAmount === 'number' && !Number.isNaN(this.totalAmount)) {
          return Math.round(this.totalAmount * 100);
        }
        return undefined;
      },
      min: [0, 'Amount in paise cannot be negative'],
      validate: {
        validator: function (v: any) {
          return v === undefined || Number.isInteger(v);
        },
        message: '{VALUE} must be an integer number of paise',
      },
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
    },
    razorpayOrderId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
    },
    razorpaySignature: {
      type: String,
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded'],
        message: '{VALUE} is not a valid order status',
      },
      default: 'pending',
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: {
        values: [
          'creating',
          'created',
          'authorized',
          'captured',
          'failed',
          'retryable_failure',
          'unknown',
          'refunded',
          'duplicate_charge_detected',
          'security_discrepancy',
          'held_for_review',
          'refund_pending',
          'partially_refunded',
        ],
        message: '{VALUE} is not a valid payment status',
      },
      default: 'creating',
      index: true,
    },
    // Dual-Ledger Financial Accounting Fields (Integer Paise)
    totalCapturedPaise: {
      type: Number,
      default: 0,
      min: [0, 'Total captured paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    purchaseCapturedPaise: {
      type: Number,
      default: 0,
      min: [0, 'Purchase captured paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    duplicateCapturedPaise: {
      type: Number,
      default: 0,
      min: [0, 'Duplicate captured paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    amountReservedRefundPaise: {
      type: Number,
      default: 0,
      min: [0, 'Amount reserved refund paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    confirmedRefundPaise: {
      type: Number,
      default: 0,
      min: [0, 'Confirmed refund paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    purchaseRefundedPaise: {
      type: Number,
      default: 0,
      min: [0, 'Purchase refunded paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    duplicateRefundedPaise: {
      type: Number,
      default: 0,
      min: [0, 'Duplicate refunded paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer number of paise',
      },
    },
    primaryPaymentId: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: [true, 'Idempotency key is required for orders'],
      index: true,
    },
    webhookEventsProcessed: {
      type: [String],
      default: [],
    },
    cartReconciled: {
      type: Boolean,
      default: false,
    },
    paymentMethod: {
      type: String,
    },
    paidAt: {
      type: Date,
    },
    failureReason: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure canonical amountPaise is always initialized from totalAmount if omitted
OrderSchema.pre('validate', function () {
  if (this.amountPaise === undefined && typeof this.totalAmount === 'number') {
    this.amountPaise = Math.round(this.totalAmount * 100);
  }
});

// Compound unique index for user-scoped idempotency keys
OrderSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);

export const Order = mongoose.models.Order || mongoose.model<IOrder>('Order', OrderSchema);

export default Order;
