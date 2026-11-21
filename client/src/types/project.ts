export type ProjectDifficulty = 'Beginner' | 'Intermediate' | 'Advanced';

export interface Project {
  id: string;
  title: string;
  description: string;
  features: string[];
  category: string;
  subcategory: string;
  price: number;
  image: string;
  rating: number;
  downloads: number;
  featured: boolean;
  difficulty?: ProjectDifficulty;
}

export interface Category {
  name: string;
  description: string;
  subcategories: string[];
  slug?: string;
}

export interface Subcategory {
  slug: string;
  name: string;
  description: string;
}
