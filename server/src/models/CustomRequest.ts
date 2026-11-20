import mongoose, { Schema, Document } from 'mongoose';

export type CustomRequestStatus = 'pending' | 'reviewing' | 'accepted' | 'rejected' | 'completed';

export interface ICustomRequest extends Document {
  userId?: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  projectType: string;
  projectCategory: string;
  description: string;
  budget?: number;
  timeline?: string;
  requirements?: string;
  status: CustomRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

const CustomRequestSchema = new Schema<ICustomRequest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      default: null,
    },
    name: {
      type: String,
      required: [true, 'Contact name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Contact email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    phone: {
      type: String,
      trim: true,
    },
    projectType: {
      type: String,
      required: [true, 'Project type is required'],
      trim: true,
    },
    projectCategory: {
      type: String,
      required: [true, 'Project category is required'],
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Project description is required'],
      trim: true,
    },
    budget: {
      type: Number,
      min: [0, 'Budget cannot be negative'],
    },
    timeline: {
      type: String,
      trim: true,
    },
    requirements: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'reviewing', 'accepted', 'rejected', 'completed'],
        message: '{VALUE} is not a valid custom request status',
      },
      default: 'pending',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const CustomRequest =
  mongoose.models.CustomRequest ||
  mongoose.model<ICustomRequest>('CustomRequest', CustomRequestSchema);

export default CustomRequest;
