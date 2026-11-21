export type ProjectDifficulty = 'Beginner' | 'Intermediate' | 'Advanced';

export interface Project {
  id: string;
  slug?: string;
  _id?: string;
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
  createdAt?: string;
  updatedAt?: string;
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

export interface PaginationMetadata {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ProjectsResponse {
  success: boolean;
  data: {
    projects: Project[];
    pagination: PaginationMetadata;
  };
}

export interface FeaturedProjectsResponse {
  success: boolean;
  data: {
    projects: Project[];
  };
}

export interface SingleProjectResponse {
  success: boolean;
  data: {
    project: Project;
  };
}

export interface ProjectQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  subcategory?: string;
  difficulty?: ProjectDifficulty;
  featured?: boolean;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'rating' | 'downloads';
}
