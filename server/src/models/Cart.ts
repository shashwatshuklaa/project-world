import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICartItem {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  quantity: number;
  customization?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ICart extends Document {
  user: Types.ObjectId;
  items: Types.DocumentArray<ICartItem & Document>;
  createdAt: Date;
  updatedAt: Date;
}

const CartItemSchema = new Schema<ICartItem>(
  {
    project: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: [true, 'Project reference is required'],
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
      max: [10, 'Maximum quantity allowed per project is 10'],
      default: 1,
    },
    customization: {
      type: String,
      trim: true,
      maxlength: [500, 'Customization notes cannot exceed 500 characters'],
      default: '',
    },
  },
  {
    timestamps: true,
    _id: true, // Generate subdocument _id for each item
  }
);

const CartSchema = new Schema<ICart>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      unique: true,
      index: true,
    },
    items: {
      type: [CartItemSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  }
);

export const Cart = mongoose.models.Cart || mongoose.model<ICart>('Cart', CartSchema);
