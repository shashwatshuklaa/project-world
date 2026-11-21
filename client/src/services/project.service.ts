import {
  ProjectQueryParams,
  ProjectsResponse,
  FeaturedProjectsResponse,
  SingleProjectResponse,
} from '../types/project';

export class ProjectApiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ProjectApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Reusable fetch wrapper for Project catalog API requests.
 * Uses Vite's /api proxy to communicate with the Express backend.
 */
async function projectFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const config: RequestInit = {
    ...options,
    headers,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, config);
  } catch {
    throw new ProjectApiError(
      'Network error. Please check your backend connection or server status.',
      0
    );
  }

  // Parse JSON response safely
  let data: unknown = null;
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorData = data as { message?: string } | null;
    const errorMessage =
      errorData?.message || `Request failed with status ${response.status}`;
    throw new ProjectApiError(errorMessage, response.status);
  }

  return data as T;
}

/**
 * Centralized Project API Service.
 */
export const projectService = {
  /**
   * Fetch curated featured projects for the homepage showcase.
   */
  async getFeaturedProjects(limit: number = 12): Promise<FeaturedProjectsResponse> {
    return projectFetch<FeaturedProjectsResponse>(
      `/api/projects/featured?limit=${encodeURIComponent(limit)}`
    );
  },

  /**
   * Fetch paginated and filtered catalog projects.
   */
  async getProjects(params: ProjectQueryParams = {}): Promise<ProjectsResponse> {
    const query = new URLSearchParams();
    if (params.page !== undefined) query.set('page', String(params.page));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.search) query.set('search', params.search);
    if (params.category) query.set('category', params.category);
    if (params.subcategory) query.set('subcategory', params.subcategory);
    if (params.difficulty) query.set('difficulty', params.difficulty);
    if (params.featured !== undefined) query.set('featured', String(params.featured));
    if (params.sort) query.set('sort', params.sort);

    const qs = query.toString();
    const endpoint = qs ? `/api/projects?${qs}` : '/api/projects';
    return projectFetch<ProjectsResponse>(endpoint);
  },

  /**
   * Fetch a single project by slug or MongoDB ObjectId.
   */
  async getProjectById(id: string): Promise<SingleProjectResponse> {
    return projectFetch<SingleProjectResponse>(`/api/projects/${encodeURIComponent(id)}`);
  },
};

export default projectService;
