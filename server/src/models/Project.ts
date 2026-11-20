import mongoose, { Schema, Document } from 'mongoose';

export interface IProject extends Document {
  slug: string; // Stable identifier matching original project ID (e.g., "eng-Drone-001")
  title: string;
  description: string;
  features: string[];
  category: string;
  subcategory: string;
  price: number; // Canonical price stored on server in INR
  image: string;
  rating: number;
  downloads: number;
  featured: boolean;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<IProject>(
  {
    slug: {
      type: String,
      required: [true, 'Project slug/ID is required'],
      unique: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Project title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Project description is required'],
      trim: true,
    },
    features: {
      type: [String],
      default: [],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      trim: true,
      index: true,
    },
    subcategory: {
      type: String,
      required: [true, 'Subcategory is required'],
      trim: true,
      index: true,
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    image: {
      type: String,
      required: [true, 'Image path is required'],
      trim: true,
    },
    rating: {
      type: Number,
      default: 0,
      min: [0, 'Rating cannot be less than 0'],
      max: [5, 'Rating cannot exceed 5'],
    },
    downloads: {
      type: Number,
      default: 0,
      min: [0, 'Downloads count cannot be negative'],
    },
    featured: {
      type: Boolean,
      default: false,
      index: true,
    },
    difficulty: {
      type: String,
      enum: ['Beginner', 'Intermediate', 'Advanced'],
      default: 'Beginner',
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for category + subcategory browsing
ProjectSchema.index({ category: 1, subcategory: 1 });

// Text index for full-text keyword searches on title and description
ProjectSchema.index({ title: 'text', description: 'text' });

export const Project = mongoose.models.Project || mongoose.model<IProject>('Project', ProjectSchema);

export default Project;
