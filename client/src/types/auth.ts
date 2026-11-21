export type UserRole = 'user' | 'admin';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  message: string;
  user: User;
}

export interface CurrentUserResponse {
  user: User;
}

export interface LogoutResponse {
  message: string;
}

export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiErrorResponse {
  message: string;
  errors?: ApiFieldError[];
}
