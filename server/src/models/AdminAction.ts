import mongoose, { Schema, Document } from 'mongoose';

export type AdminActionItemType = 'order' | 'custom';

export interface IAdminAction extends Document {
  userId: mongoose.Types.ObjectId;
  itemId: string;
  itemType: AdminActionItemType;
  isCompleted: boolean;
  actionDate: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AdminActionSchema = new Schema<IAdminAction>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Admin user reference is required'],
      index: true,
    },
    itemId: {
      type: String,
      required: [true, 'Item ID is required'],
      index: true,
    },
    itemType: {
      type: String,
      enum: {
        values: ['order', 'custom'],
        message: '{VALUE} must be either "order" or "custom"',
      },
      required: [true, 'Item type is required'],
      index: true,
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    actionDate: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Unique compound index so an admin has only one tracking record per item
AdminActionSchema.index({ userId: 1, itemId: 1, itemType: 1 }, { unique: true });

export const AdminAction =
  mongoose.models.AdminAction ||
  mongoose.model<IAdminAction>('AdminAction', AdminActionSchema);

export default AdminAction;
