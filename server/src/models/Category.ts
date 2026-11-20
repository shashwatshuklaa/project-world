import mongoose, { Schema, Document } from 'mongoose';

export interface ISubcategory {
  slug: string;
  name: string;
  description?: string;
}

export interface ICategory extends Document {
  slug: string;
  name: string;
  description: string;
  subcategories: ISubcategory[];
  createdAt: Date;
  updatedAt: Date;
}

const SubcategorySchema = new Schema<ISubcategory>(
  {
    slug: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const CategorySchema = new Schema<ICategory>(
  {
    slug: {
      type: String,
      required: [true, 'Category slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Category name is required'],
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Category description is required'],
      trim: true,
    },
    subcategories: [SubcategorySchema],
  },
  {
    timestamps: true,
  }
);

export const Category = mongoose.models.Category || mongoose.model<ICategory>('Category', CategorySchema);

export default Category;
