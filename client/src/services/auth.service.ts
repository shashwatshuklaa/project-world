import {
  LoginInput,
  RegisterInput,
  AuthResponse,
  CurrentUserResponse,
  LogoutResponse,
  ApiErrorResponse,
  ApiFieldError,
} from '../types/auth';

export class AuthError extends Error {
  statusCode: number;
  errors?: ApiFieldError[];

  constructor(message: string, statusCode: number, errors?: ApiFieldError[]) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

/**
 * Reusable fetch wrapper for authentication requests.
 * Automatically enforces credentials: 'include', JSON parsing, and error normalization.
 */
async function authFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const config: RequestInit = {
    ...options,
    headers,
    credentials: 'include', // Guarantees HTTP-only cookies are transmitted
  };

  let response: Response;
  try {
    response = await fetch(endpoint, config);
  } catch (err) {
    throw new AuthError(
      'Network error. Please check your internet connection or backend server status.',
      0
    );
  }

  // Parse JSON response safely
  let data: any = null;
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorData = data as ApiErrorResponse | null;
    const errorMessage =
      errorData?.message || `Request failed with status ${response.status}`;
    throw new AuthError(errorMessage, response.status, errorData?.errors);
  }

  return data as T;
}

/**
 * Centralized Authentication API service.
 */
export const authService = {
  /**
   * Log in an existing user with email and password.
   * HTTP-only auth cookie is set automatically by the server.
   */
  async login(credentials: LoginInput): Promise<AuthResponse> {
    return authFetch<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
  },

  /**
   * Register a new user account.
   * HTTP-only auth cookie is set automatically by the server.
   */
  async register(data: RegisterInput): Promise<AuthResponse> {
    return authFetch<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /**
   * Log out the current user and clear the authentication cookie.
   */
  async logout(): Promise<LogoutResponse> {
    return authFetch<LogoutResponse>('/api/auth/logout', {
      method: 'POST',
    });
  },

  /**
   * Retrieve the current authenticated user's profile.
   * Sends the HTTP-only cookie automatically.
   */
  async getCurrentUser(): Promise<CurrentUserResponse> {
    return authFetch<CurrentUserResponse>('/api/auth/me', {
      method: 'GET',
    });
  },
};

export default authService;
