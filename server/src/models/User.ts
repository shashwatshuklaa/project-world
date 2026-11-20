import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';

export type UserRole = 'user' | 'admin';

export interface IUser extends Document {
  email: string;
  name: string;
  hashedPassword: string;
  salt: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
  setPassword: (password: string) => void;
  validatePassword: (password: string) => boolean;
}

export interface IUserMethods {
  setPassword(password: string): void;
  validatePassword(password: string): boolean;
}

type UserModel = Model<IUser, {}, IUserMethods>;

const UserSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters long'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    hashedPassword: {
      type: String,
      required: [true, 'Password hash is required'],
    },
    salt: {
      type: String,
      required: [true, 'Salt is required'],
    },
    role: {
      type: String,
      enum: {
        values: ['user', 'admin'],
        message: '{VALUE} is not a valid role',
      },
      default: 'user',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Method to set user password using PBKDF2 (compatible with existing hashes)
UserSchema.methods.setPassword = function (password: string): void {
  this.salt = crypto.randomBytes(16).toString('hex');
  this.hashedPassword = crypto
    .pbkdf2Sync(password, this.salt, 1000, 64, 'sha512')
    .toString('hex');
};

// Method to validate password against PBKDF2 hash
UserSchema.methods.validatePassword = function (password: string): boolean {
  if (!this.salt || !this.hashedPassword) {
    return false;
  }
  const hash = crypto
    .pbkdf2Sync(password, this.salt, 1000, 64, 'sha512')
    .toString('hex');
  return crypto.timingSafeEqual(Buffer.from(this.hashedPassword), Buffer.from(hash));
};

export const User = mongoose.models.User || mongoose.model<IUser, UserModel>('User', UserSchema);

export default User;
