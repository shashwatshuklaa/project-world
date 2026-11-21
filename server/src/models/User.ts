import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export type UserRole = 'user' | 'admin';

export interface ISafeUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUser extends Document {
  email: string;
  name: string;
  hashedPassword: string;
  salt?: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
  setPassword: (password: string) => void;
  validatePassword: (password: string) => boolean;
  toSafeObject: () => ISafeUser;
}

export interface IUserMethods {
  setPassword(password: string): void;
  validatePassword(password: string): boolean;
  toSafeObject(): ISafeUser;
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
      select: false, // Hidden from queries by default
    },
    salt: {
      type: String,
      default: '',
      select: false,
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
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id?.toString() || ret.id;
        delete ret._id;
        delete ret.__v;
        delete ret.hashedPassword;
        delete ret.salt;
        return ret;
      },
    },
  }
);

// Method to set user password using bcrypt (work factor 10)
UserSchema.methods.setPassword = function (password: string): void {
  this.hashedPassword = bcrypt.hashSync(password, 10);
  this.salt = '';
};

// Method to validate password against bcrypt hash or legacy PBKDF2 hash
UserSchema.methods.validatePassword = function (password: string): boolean {
  if (!this.hashedPassword) {
    return false;
  }

  // 1. Check if hash is a standard bcrypt hash ($2a$ or $2b$)
  if (this.hashedPassword.startsWith('$2a$') || this.hashedPassword.startsWith('$2b$')) {
    return bcrypt.compareSync(password, this.hashedPassword);
  }

  // 2. Backward compatibility fallback for legacy PBKDF2 hashes
  if (this.salt) {
    const hash = crypto
      .pbkdf2Sync(password, this.salt, 1000, 64, 'sha512')
      .toString('hex');
    if (this.hashedPassword.length === hash.length) {
      return crypto.timingSafeEqual(Buffer.from(this.hashedPassword), Buffer.from(hash));
    }
  }

  return false;
};

// Method to return safe profile data
UserSchema.methods.toSafeObject = function (): ISafeUser {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    role: this.role,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const User = mongoose.models.User || mongoose.model<IUser, UserModel>('User', UserSchema);

export default User;
