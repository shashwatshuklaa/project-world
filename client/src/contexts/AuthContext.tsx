import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react';
import { User, LoginInput, RegisterInput } from '../types/auth';
import { authService, AuthError } from '../services/auth.service';

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginInput) => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Authentication Provider component.
 * Manages global authentication state backed by backend HTTP-only cookies.
 * Does not store JWT tokens in localStorage or sessionStorage.
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Check active session on initial application load
  useEffect(() => {
    let isMounted = true;

    const checkSession = async () => {
      try {
        const response = await authService.getCurrentUser();
        if (isMounted) {
          setUser(response.user);
        }
      } catch (error) {
        // 401 indicates no active session, which is normal for guest users
        if (error instanceof AuthError && error.statusCode === 401) {
          if (isMounted) {
            setUser(null);
          }
        } else {
          // Handle network or unexpected errors gracefully
          console.warn('[AuthContext] Session verification check failed:', error);
          if (isMounted) {
            setUser(null);
          }
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    checkSession();

    return () => {
      isMounted = false;
    };
  }, []);

  /**
   * Log in user with credentials and update global auth state.
   * Propagates errors to caller for UI error handling.
   */
  const login = async (credentials: LoginInput): Promise<void> => {
    const response = await authService.login(credentials);
    setUser(response.user);
  };

  /**
   * Register user and update global auth state with returned profile.
   * Propagates errors to caller for UI error handling.
   */
  const register = async (data: RegisterInput): Promise<void> => {
    const response = await authService.register(data);
    setUser(response.user);
  };

  /**
   * Log out user, clear backend session cookie, and reset local auth state.
   * Guarantees local state is cleared even if the network call fails.
   */
  const logout = async (): Promise<void> => {
    try {
      await authService.logout();
    } catch (error) {
      console.warn('[AuthContext] Backend logout request failed:', error);
    } finally {
      setUser(null);
    }
  };

  const value: AuthContextType = {
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    login,
    register,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * Custom hook to consume the global authentication state.
 * Throws an error if invoked outside an AuthProvider.
 */
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export { AuthError } from '../services/auth.service';

export default AuthContext;
