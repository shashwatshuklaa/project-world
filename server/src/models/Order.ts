import mongoose, { Schema, Document } from 'mongoose';

export type OrderStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IOrderItem {
  projectId: mongoose.Types.ObjectId;
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
  orderId: string; // Internal UUID receipt
  userId: mongoose.Types.ObjectId;
  items: IOrderItem[];
  totalAmount: number; // Server-calculated canonical total amount in INR
  currency: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  status: OrderStatus;
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
      required: [true, 'Order receipt ID is required'],
      unique: true,
      index: true,
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
    currency: {
      type: String,
      default: 'INR',
    },
    razorpayOrderId: {
      type: String,
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
        values: ['pending', 'processing', 'completed', 'failed'],
        message: '{VALUE} is not a valid order status',
      },
      default: 'pending',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Order = mongoose.models.Order || mongoose.model<IOrder>('Order', OrderSchema);

export default Order;
